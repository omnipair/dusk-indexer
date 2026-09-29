//! Live-cluster Dusk ingestion daemon.
//!
//! Streams every confirmed transaction that touches the pinned Dusk or
//! leverage-delegate program through a Carbon pipeline fed by a Helius Atlas
//! WebSocket, decodes every event it carries — Anchor event-CPI inner
//! instructions and `Program data:` logs alike — through the pinned IDL
//! decoder, and persists them into the `dusk_ingestion` schema plus the
//! `event_stream` hypertable as they land. This is the v1 indexer's shape.
//!
//! There is no backfill. The stream starts at the current slot, and a dropped
//! connection or a restart leaves its window out, as in v1. The deployment is
//! attested once at startup. Nothing reads program accounts: every table is
//! built from the events the stream carries.

mod extract;
mod identity;
mod liveness;
mod orders;
mod persist;
mod pipeline;
mod processors;

use {
    anyhow::{anyhow, Context as _, Result},
    dusk_indexer_foundation::{decoder::PinnedIdlDecoder, verify_vendored_protocol},
    solana_client::{nonblocking::rpc_client::RpcClient, rpc_config::RpcTransactionConfig},
    solana_commitment_config::CommitmentConfig,
    solana_signature::Signature,
    solana_transaction_status::UiTransactionEncoding,
    sqlx::PgPool,
    std::{str::FromStr, sync::Arc, time::Duration},
    tokio::sync::Mutex,
};

/// The datasource reconnects after 5 s without a Clock update.
const STREAM_LIVENESS: Duration = Duration::from_secs(10);
/// The API serves the cursor's time as the deployment envelope's observation
/// time, and clients refuse a stream frame whose envelope is 15 s old.
const HEARTBEAT: Duration = Duration::from_secs(5);

struct Config {
    cluster: String,
    rpc_url: String,
    database_url: String,
    /// Only streaming needs it; `--replay` reads over plain RPC.
    helius_api_key: Option<String>,
    metrics_port: u16,
}

impl Config {
    fn from_env() -> Result<Self> {
        let cluster = std::env::var("DUSK_CLUSTER").context("DUSK_CLUSTER is required")?;
        let rpc_url = std::env::var("DUSK_RPC_URL").context("DUSK_RPC_URL is required")?;
        let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
        // The Helius RPC URL already carries the key the WebSocket needs.
        let helius_api_key = std::env::var("HELIUS_API_KEY")
            .ok()
            .filter(|key| !key.is_empty())
            .or_else(|| api_key_from_url(&rpc_url));
        let metrics_port = std::env::var("METRICS_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(8080);
        Ok(Self {
            cluster,
            rpc_url,
            database_url,
            helius_api_key,
            metrics_port,
        })
    }
}

fn flag_value(name: &str) -> Option<String> {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next();
        }
    }
    None
}

fn api_key_from_url(url: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| *name == "api-key")
        .map(|(_, value)| value.to_owned())
        .filter(|value| !value.is_empty())
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv_optional();
    env_logger::init();

    // Refuse to start on artifacts that disagree with the compiled pin —
    // exactly the check the decoder performs, surfaced before any I/O.
    verify_vendored_protocol().map_err(|error| anyhow!(error.to_string()))?;

    let config = Config::from_env()?;
    let decoder = Arc::new(
        PinnedIdlDecoder::new(config.cluster.clone())
            .map_err(|error| anyhow!(error.to_string()))?,
    );
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await
        .context("connecting to postgres")?;
    persist::ensure_protocol_identity(&pool, &config.cluster).await?;

    let rpc = RpcClient::new_with_commitment(config.rpc_url.clone(), CommitmentConfig::finalized());
    let mut attestation = identity::Attestation::default();
    attestation.verify(&rpc, &config.cluster).await?;
    let window = attestation.window()?;
    // The database lock describes the original executable. Its historical
    // verified-through bound must not be extended using the current binary's
    // attestation. Migration 044 lets the compatible event stream continue
    // past that bound under the same program/IDL revision.
    persist::record_deployment(
        &pool,
        &config.cluster,
        identity::DeploymentWindow {
            through_slot: window.first_slot,
            ..window
        },
    )
    .await?;
    let (stop, mut stopped) = tokio::sync::mpsc::unbounded_channel();
    let guard = processors::DeploymentGuard {
        pinned: Arc::new(identity::PinnedDeployments::load()?),
        stop,
    };

    // The stream logs every transaction it drops; this re-ingests one.
    if let Some(signature) = flag_value("--replay") {
        let fetched = rpc
            .get_transaction_with_config(
                &Signature::from_str(&signature).context("invalid --replay signature")?,
                RpcTransactionConfig {
                    encoding: Some(UiTransactionEncoding::Base64),
                    commitment: Some(CommitmentConfig::confirmed()),
                    max_supported_transaction_version: Some(0),
                },
            )
            .await
            .with_context(|| format!("getTransaction {signature}"))?;
        let processor = processors::DuskTransactionProcessor::new(
            pool,
            decoder,
            config.cluster.clone(),
            window.first_slot,
            Arc::default(),
            guard,
        );
        let events = processor
            .replay(&processors::metadata_from_rpc(&fetched)?)
            .await?;
        println!(
            "{}",
            serde_json::json!({"replayedTransaction": signature, "events": events})
        );
        return Ok(());
    }

    log::info!(
        "dusk-indexer-daemon streaming: cluster={} first_slot={}",
        config.cluster,
        window.first_slot,
    );

    let liveness = Arc::new(liveness::StreamLiveness::default());
    let cursor = Arc::new(Mutex::new(()));
    let heartbeat = tokio::spawn(heartbeat(
        pool.clone(),
        config.cluster.clone(),
        liveness.clone(),
        cursor.clone(),
    ));

    let result = tokio::select! {
        result = stream(&config, pool, decoder, window.first_slot, liveness, cursor, guard) => result,
        Some(error) = stopped.recv() => Err(error),
        _ = shutdown_signal() => {
            log::info!("shutdown signal received");
            Ok(())
        }
    };
    heartbeat.abort();
    result
}

/// The pipeline, rebuilt after any failure with the v1 indexer's backoff. The
/// datasource reconnects on its own; a failed run means the pipeline stopped.
async fn stream(
    config: &Config,
    pool: PgPool,
    decoder: Arc<PinnedIdlDecoder>,
    first_slot: u64,
    liveness: Arc<liveness::StreamLiveness>,
    cursor: Arc<Mutex<()>>,
    guard: processors::DeploymentGuard,
) -> Result<()> {
    let api_key = config
        .helius_api_key
        .as_deref()
        .context("HELIUS_API_KEY is required to stream (or an api-key in DUSK_RPC_URL)")?;
    let mut retry = Duration::from_secs(1);
    loop {
        let datasource = pipeline::helius_datasource(api_key, &config.cluster)?;
        let processor = processors::DuskTransactionProcessor::new(
            pool.clone(),
            decoder.clone(),
            config.cluster.clone(),
            first_slot,
            cursor.clone(),
            guard.clone(),
        );
        let mut run = pipeline::build(datasource, processor, config.metrics_port, liveness.clone())
            .map_err(|error| anyhow!("building pipeline: {error:?}"))?;
        match run.run().await {
            Ok(()) => {
                log::warn!("pipeline finished; restarting");
                retry = Duration::from_secs(1);
            }
            Err(error) => {
                log::error!(
                    "pipeline failed: {error:?}; restarting in {}s",
                    retry.as_secs()
                );
                tokio::time::sleep(retry).await;
                retry = (retry * 2).min(Duration::from_secs(30));
                continue;
            }
        }
        tokio::time::sleep(retry).await;
    }
}

/// A quiet market must not look like a dead ingester, and a dead stream must
/// not look like a quiet market. The cursor's time is history coverage and
/// `/status` liveness, so it moves only while the WebSocket delivers verified
/// Clock updates.
async fn heartbeat(
    pool: PgPool,
    cluster: String,
    liveness: Arc<liveness::StreamLiveness>,
    cursor: Arc<Mutex<()>>,
) {
    loop {
        tokio::time::sleep(HEARTBEAT).await;
        if !liveness.live_within(STREAM_LIVENESS) {
            log::warn!(
                "no verified Clock update for {}s; cursor heartbeat withheld",
                STREAM_LIVENESS.as_secs()
            );
            continue;
        }
        let _cursor = cursor.lock().await;
        if let Err(error) = persist::touch_cursor(&pool, &cluster, chrono::Utc::now()).await {
            log::warn!("cursor heartbeat failed: {error:#}");
        }
    }
}

fn dotenv_optional() {
    for candidate in [".env", "indexer/dusk.env"] {
        if std::path::Path::new(candidate).exists() {
            let _ = dotenvy_load(candidate);
        }
    }
}

/// Minimal .env loader: KEY=VALUE lines, no interpolation, never overrides
/// variables already present in the environment.
fn dotenvy_load(path: &str) -> std::io::Result<()> {
    let body = std::fs::read_to_string(path)?;
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            if std::env::var_os(key).is_none() {
                std::env::set_var(key, value.trim().trim_matches('"'));
            }
        }
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = sigterm.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
}

#[cfg(test)]
mod tests {
    use super::api_key_from_url;

    #[test]
    fn reads_the_helius_key_from_the_rpc_url() {
        assert_eq!(
            api_key_from_url("https://devnet.helius-rpc.com/?api-key=abc123").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            api_key_from_url("https://rpc.example/?x=1&api-key=k&y=2").as_deref(),
            Some("k")
        );
        assert_eq!(api_key_from_url("https://rpc.example/"), None);
        assert_eq!(api_key_from_url("https://rpc.example/?api-key="), None);
    }
}

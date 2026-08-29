//! Live-cluster Dusk ingestion daemon.
//!
//! Polls `getSignaturesForAddress` for the pinned Dusk program at finalized
//! commitment, decodes every event a transaction carries — Anchor event-CPI
//! inner instructions and `Program data:` logs alike — through the pinned IDL
//! decoder, and persists them into the `dusk_ingestion` schema plus the
//! `event_stream` hypertable.
//!
//! Finalized-only on purpose: a live cluster's finalized history cannot fork,
//! so canonical rows are written directly and the foundation's fork-resolution
//! machinery stays out of the hot path. The cost is finality latency
//! (~seconds), which discovery and history — this daemon's consumers — can
//! afford. Keepers read chain state directly and never wait on this pipeline.

mod extract;
mod persist;

use {
    anyhow::{Context as _, Result},
    dusk_indexer_foundation::{
        decoder::PinnedIdlDecoder, verify_vendored_protocol, DUSK_PROGRAM_ID,
    },
    solana_client::{
        nonblocking::rpc_client::RpcClient,
        rpc_client::GetConfirmedSignaturesForAddress2Config,
        rpc_config::RpcTransactionConfig,
    },
    solana_commitment_config::CommitmentConfig,
    solana_pubkey::Pubkey,
    solana_signature::Signature,
    solana_transaction_status::UiTransactionEncoding,
    std::{str::FromStr, time::Duration},
};

struct Config {
    cluster: String,
    rpc_url: String,
    database_url: String,
    poll_interval: Duration,
    /// Signatures fetched per page; also bounds catch-up burst size.
    page_limit: usize,
}

impl Config {
    fn from_env() -> Result<Self> {
        let cluster = std::env::var("DUSK_CLUSTER").context("DUSK_CLUSTER is required")?;
        let rpc_url = std::env::var("DUSK_RPC_URL").context("DUSK_RPC_URL is required")?;
        let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
        let poll_interval = Duration::from_millis(
            std::env::var("DUSK_POLL_INTERVAL_MS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(15_000),
        );
        let page_limit = std::env::var("DUSK_SIGNATURE_PAGE_LIMIT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(200)
            .clamp(10, 1_000);
        Ok(Self {
            cluster,
            rpc_url,
            database_url,
            poll_interval,
            page_limit,
        })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv_optional();
    env_logger::init();

    // Refuse to start on artifacts that disagree with the compiled pin —
    // exactly the check the decoder performs, surfaced before any I/O.
    verify_vendored_protocol().map_err(|error| anyhow::anyhow!(error.to_string()))?;

    let config = Config::from_env()?;
    let decoder = PinnedIdlDecoder::new(config.cluster.clone())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let program = Pubkey::from_str(DUSK_PROGRAM_ID)?;

    log::info!(
        "dusk-indexer-daemon starting: cluster={} program={} poll={}ms",
        config.cluster,
        program,
        config.poll_interval.as_millis(),
    );

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await
        .context("connecting to postgres")?;
    persist::ensure_protocol_identity(&pool, &config.cluster).await?;

    let rpc = RpcClient::new_with_commitment(
        config.rpc_url.clone(),
        CommitmentConfig::finalized(),
    );

    let mut shutdown = std::pin::pin!(shutdown_signal());
    loop {
        tokio::select! {
            _ = &mut shutdown => {
                log::info!("shutdown signal received; draining");
                break;
            }
            result = ingest_once(&rpc, &pool, &decoder, &config, &program) => {
                match result {
                    Ok(0) => {}
                    Ok(count) => log::info!("ingested {count} new transactions"),
                    // Transient RPC/database trouble must not kill the daemon;
                    // the cursor guarantees the next pass re-covers the gap.
                    Err(error) => log::warn!("ingestion pass failed: {error:#}"),
                }
                tokio::time::sleep(config.poll_interval).await;
            }
        }
    }
    Ok(())
}

/// One poll: everything newer than the cursor, oldest first.
async fn ingest_once(
    rpc: &RpcClient,
    pool: &sqlx::PgPool,
    decoder: &PinnedIdlDecoder,
    config: &Config,
    program: &Pubkey,
) -> Result<usize> {
    let cursor = persist::load_cursor(pool, &config.cluster).await?;
    let until = cursor
        .as_deref()
        .map(Signature::from_str)
        .transpose()
        .context("stored cursor signature is invalid")?;

    // Newest-first pages walked back until the cursor (or history start).
    let mut new_signatures = Vec::new();
    let mut before = None;
    loop {
        let page = rpc
            .get_signatures_for_address_with_config(
                program,
                GetConfirmedSignaturesForAddress2Config {
                    before,
                    until,
                    limit: Some(config.page_limit),
                    commitment: Some(CommitmentConfig::finalized()),
                },
            )
            .await
            .context("getSignaturesForAddress")?;
        let page_len = page.len();
        let last = page.last().map(|entry| entry.signature.clone());
        new_signatures.extend(page);
        if page_len < config.page_limit {
            break;
        }
        before = last.as_deref().map(Signature::from_str).transpose()?;
    }
    if new_signatures.is_empty() {
        return Ok(0);
    }

    // Oldest first, so the cursor only ever advances over persisted work.
    new_signatures.reverse();
    let mut ingested = 0usize;
    for entry in new_signatures {
        // A failed transaction executed no instructions and emitted nothing;
        // it still advances the cursor so reprocessing stays bounded.
        if entry.err.is_none() {
            let signature = Signature::from_str(&entry.signature)?;
            let transaction = rpc
                .get_transaction_with_config(
                    &signature,
                    RpcTransactionConfig {
                        encoding: Some(UiTransactionEncoding::Json),
                        commitment: Some(CommitmentConfig::finalized()),
                        max_supported_transaction_version: Some(0),
                    },
                )
                .await
                .with_context(|| format!("getTransaction {signature}"))?;
            let observed = extract::decode_transaction(decoder, &entry.signature, &transaction)?;
            for event in &observed.events {
                persist::persist_event(pool, event, observed.block_time).await?;
            }
            if !observed.events.is_empty() {
                log::info!(
                    "slot {}: {} event(s) in {} [{}]",
                    observed.slot,
                    observed.events.len(),
                    &entry.signature[..8],
                    observed.event_names().join(", "),
                );
            }
        }
        persist::advance_cursor(pool, &config.cluster, &entry.signature, entry.slot).await?;
        ingested += 1;
    }
    Ok(ingested)
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
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
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

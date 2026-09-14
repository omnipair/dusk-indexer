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

mod accounts;
mod extract;
mod history;
mod identity;
mod persist;
mod scans;

use {
    anyhow::{Context as _, Result},
    dusk_indexer_foundation::{
        decoder::PinnedIdlDecoder, verify_vendored_protocol, DUSK_PROGRAM_ID,
    },
    solana_client::{
        nonblocking::rpc_client::RpcClient,
        rpc_config::{RpcBlockConfig, RpcTransactionConfig},
    },
    solana_commitment_config::CommitmentConfig,
    solana_pubkey::Pubkey,
    solana_signature::Signature,
    solana_transaction_status::{TransactionDetails, UiTransactionEncoding},
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

    let rpc = RpcClient::new_with_commitment(config.rpc_url.clone(), CommitmentConfig::finalized());

    let mut attestation = identity::Attestation::default();
    attestation.verify(&rpc, &config.cluster).await?;
    if std::env::args().any(|arg| arg == "--ingest-once") {
        let count = ingest_once(&rpc, &pool, &decoder, &config, &program, &mut attestation).await?;
        let window = attestation.window()?;
        println!(
            "{}",
            serde_json::json!({"cluster":config.cluster,"ingestedTransactions":count,
            "firstDeploymentSlot":window.first_slot,"attestedThroughSlot":window.through_slot,
            "submittedTransactions":0})
        );
        return Ok(());
    }
    if std::env::args().any(|arg| arg == "--scan-accounts-once") {
        accounts::capture(&rpc, &pool, &decoder, &config.cluster, &mut attestation).await?;
        return Ok(());
    }

    let mut shutdown = std::pin::pin!(shutdown_signal());
    loop {
        attestation.verify(&rpc, &config.cluster).await?;
        tokio::select! {
            _ = &mut shutdown => {
                log::info!("shutdown signal received; draining");
                break;
            }
            result = ingest_once(&rpc, &pool, &decoder, &config, &program, &mut attestation) => {
                match result {
                    // A pass that found nothing still proves the daemon is
                    // polling, which is the difference between a quiet market
                    // and a dead ingester. Recorded as a cursor heartbeat
                    // rather than a log line, so the signal is queryable by
                    // whatever is watching rather than only greppable.
                    Ok(0) => {
                        if let Err(error) = persist::touch_cursor(&pool, &config.cluster).await {
                            log::warn!("cursor heartbeat failed: {error:#}");
                        }
                    }
                    Ok(count) => log::info!("ingested {count} new transactions"),
                    // Transient RPC/database trouble must not kill the daemon;
                    // the cursor guarantees the next pass re-covers the gap.
                    Err(error) if format!("{error:#}").contains("FINALIZED_INVARIANT") => return Err(error),
                    Err(error) => log::warn!("ingestion pass failed: {error:#}"),
                }
                if let Err(error) = accounts::capture(&rpc, &pool, &decoder, &config.cluster, &mut attestation).await {
                    if format!("{error:#}").contains("FINALIZED_INVARIANT") { return Err(error); }
                    log::warn!("native account scan failed: {error:#}");
                }
                tokio::time::sleep(config.poll_interval).await;
            }
        }
    }
    Ok(())
}

/// One poll: the next uncovered finalized interval, oldest first.
async fn ingest_once(
    rpc: &RpcClient,
    pool: &sqlx::PgPool,
    decoder: &PinnedIdlDecoder,
    config: &Config,
    program: &Pubkey,
    attestation: &mut identity::Attestation,
) -> Result<usize> {
    let window = attestation.window()?;
    persist::record_deployment(pool, &config.cluster, window).await?;
    // Hold one transaction-scoped lock across enumeration, decoding and commit.
    // Interrupted passes leave canonical observations intact but no coverage.
    let mut scan = pool.begin().await?;
    if !scans::lock(&mut scan, &config.cluster).await? {
        return Ok(0);
    }
    let start = scans::next_slot(&mut scan, &config.cluster, window).await?;
    if start > window.through_slot {
        return Ok(0);
    }
    let scan_window = identity::DeploymentWindow {
        first_slot: start,
        ..window
    };

    // Newest-first pages walked back past the last covered slot (or release start).
    let mut new_signatures = Vec::new();
    let mut before = None;
    let mut pagination = history::Pagination::default();
    let boundary = loop {
        // No `until`: observe the actual lower boundary instead of treating an
        // empty/pruned page as proof that a stored cursor was reached.
        let page: Vec<solana_client::rpc_response::RpcConfirmedTransactionStatusWithSignature> =
            rpc.send(
                solana_client::rpc_request::RpcRequest::GetSignaturesForAddress,
                serde_json::json!([program.to_string(), {
                    "before": before, "limit": config.page_limit,
                    "commitment": "finalized", "minContextSlot": window.through_slot
                }]),
            )
            .await
            .context("getSignaturesForAddress")?;
        let selected = pagination.select(
            &page
                .iter()
                .map(|entry| (entry.signature.as_str(), entry.slot))
                .collect::<Vec<_>>(),
            scan_window,
        )?;
        for entry in &page {
            Signature::from_str(&entry.signature).context("invalid finalized signature")?;
            if entry.confirmation_status
                != Some(solana_transaction_status::TransactionConfirmationStatus::Finalized)
            {
                anyhow::bail!("signature listing is not finalized");
            }
        }
        before = page.last().map(|entry| entry.signature.clone());
        let boundary = selected.reached_start.then(|| {
            let entry = &page[selected.range.end];
            (entry.signature.clone(), entry.slot)
        });
        new_signatures.extend(
            page.into_iter()
                .skip(selected.range.start)
                .take(selected.range.len()),
        );
        if let Some(boundary) = boundary {
            break boundary;
        }
    };
    attestation.verify(rpc, &config.cluster).await?;

    // Oldest first, so the cursor only ever advances over persisted work.
    new_signatures.reverse();
    let mut receipts = Vec::new();
    for entry in new_signatures {
        window.require_slot(entry.slot)?;
        attestation.verify(rpc, &config.cluster).await?;
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
        if transaction.slot != entry.slot {
            anyhow::bail!("FINALIZED_INVARIANT: signature and transaction slots differ");
        }
        window.require_slot(transaction.slot)?;
        let block = rpc
            .get_block_with_config(
                transaction.slot,
                RpcBlockConfig {
                    encoding: Some(UiTransactionEncoding::Json),
                    transaction_details: Some(TransactionDetails::None),
                    rewards: Some(false),
                    commitment: Some(CommitmentConfig::finalized()),
                    max_supported_transaction_version: Some(0),
                },
            )
            .await
            .context("reading containing finalized block")?;
        scans::validate_transaction(&entry, &transaction)?;
        let transaction_sha = scans::transaction_hash(&transaction)?;
        let observed = if entry.err.is_none() {
            Some(extract::decode_transaction(
                decoder,
                &entry.signature,
                &transaction,
                &block.blockhash,
                block.parent_slot,
                block.block_time,
            )?)
        } else {
            None
        };
        attestation.verify(rpc, &config.cluster).await?;
        let mut keys = Vec::new();
        if let Some(observed) = observed {
            for event in &observed.events {
                persist::persist_event(pool, event, observed.block_time, window).await?;
                keys.push(event.canonical_record().event_key);
            }
            log::debug!(
                "slot {}: {} event(s) [{}]",
                observed.slot,
                keys.len(),
                observed.event_names().join(", ")
            );
        }
        keys.sort();
        receipts.push(serde_json::json!({
            "signature": entry.signature, "slot": entry.slot, "blockhash": block.blockhash,
            "failed": entry.err.is_some(), "transactionSha256": transaction_sha, "eventKeys": keys
        }));
        attestation.verify(rpc, &config.cluster).await?;
        persist::advance_cursor(pool, &config.cluster, &entry.signature, entry.slot, window)
            .await?;
    }
    let through = rpc
        .get_block_with_config(
            window.through_slot,
            RpcBlockConfig {
                encoding: Some(UiTransactionEncoding::Json),
                transaction_details: Some(TransactionDetails::None),
                rewards: Some(false),
                commitment: Some(CommitmentConfig::finalized()),
                max_supported_transaction_version: Some(0),
            },
        )
        .await
        .context("reading history upper boundary")?;
    let release_time = rpc
        .get_block_time(window.first_slot - 1)
        .await
        .context("reading deployment block time")?;
    attestation.verify(rpc, &config.cluster).await?;
    scans::record(
        &mut scan,
        &config.cluster,
        scan_window,
        &boundary,
        &through.blockhash,
        through
            .block_time
            .context("history boundary has no block time")?,
        release_time,
        &receipts,
    )
    .await?;
    scan.commit().await?;
    Ok(receipts.len())
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

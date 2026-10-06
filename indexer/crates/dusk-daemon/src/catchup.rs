//! Recovering the transactions the stream missed.
//!
//! The WebSocket starts at the chain tip, so a restart, a deploy or a dropped
//! connection leaves out every transaction confirmed in between. When the
//! stream starts delivering after such a gap, the gap is read back with
//! `getSignaturesForAddress` for both pinned programs, from the cursor's last
//! written slot, and each transaction is replayed through the stream's own
//! path. Writes are idempotent by event key, so the overlap with what the
//! stream already wrote deduplicates, and the streamed projections order by
//! slot, so a late older event lands in its place.
//!
//! Only the pinned release is covered: `first_slot` bounds every replay.
//! History from earlier program revisions is out of scope.

use {
    crate::{liveness::StreamLiveness, persist, processors},
    anyhow::{Context as _, Result},
    dusk_indexer_foundation::{DUSK_PROGRAM_ID, LEVERAGE_DELEGATE_PROGRAM_ID},
    solana_client::{
        nonblocking::rpc_client::RpcClient, rpc_client::GetConfirmedSignaturesForAddress2Config,
        rpc_config::RpcTransactionConfig, rpc_response::RpcConfirmedTransactionStatusWithSignature,
    },
    solana_commitment_config::CommitmentConfig,
    solana_pubkey::Pubkey,
    solana_signature::Signature,
    solana_transaction_status::UiTransactionEncoding,
    sqlx::PgPool,
    std::{collections::HashSet, str::FromStr, sync::Arc, time::Duration},
    tokio::sync::Mutex,
};

/// `getSignaturesForAddress` returns at most this many per page.
const PAGE: usize = 1000;
/// Clock updates arrive about every slot, so a few seconds without one means
/// the socket dropped, even if it reconnects before the heartbeat notices.
const GAP: Duration = Duration::from_secs(3);
const CHECK: Duration = Duration::from_secs(1);

/// One transaction to replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Missed {
    pub slot: u64,
    pub signature: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub from_slot: u64,
    pub found: usize,
    pub replayed: usize,
    pub events: usize,
    pub failed: usize,
}

/// Successful transactions at or above `from_slot`, oldest first, once each
/// even when both programs list them.
pub fn plan(
    signatures: impl IntoIterator<Item = RpcConfirmedTransactionStatusWithSignature>,
    from_slot: u64,
) -> Vec<Missed> {
    let mut seen = HashSet::new();
    let mut missed: Vec<Missed> = signatures
        .into_iter()
        .filter(|status| status.err.is_none() && status.slot >= from_slot)
        .filter(|status| seen.insert(status.signature.clone()))
        .map(|status| Missed {
            slot: status.slot,
            signature: status.signature,
        })
        .collect();
    // Same-slot order is not recoverable from signatures; event keys carry
    // the instruction position, so it does not affect what is stored.
    missed.sort_by(|a, b| a.slot.cmp(&b.slot).then(a.signature.cmp(&b.signature)));
    missed
}

/// Pages run newest first. Another page can still reach `from_slot` only if
/// this one was full and its oldest entry has not passed it.
fn more(page: &[RpcConfirmedTransactionStatusWithSignature], from_slot: u64) -> bool {
    page.len() == PAGE && page.last().is_some_and(|status| status.slot >= from_slot)
}

async fn signatures_since(
    rpc: &RpcClient,
    program: &Pubkey,
    from_slot: u64,
) -> Result<Vec<RpcConfirmedTransactionStatusWithSignature>> {
    let mut all = Vec::new();
    let mut before = None;
    loop {
        let page = rpc
            .get_signatures_for_address_with_config(
                program,
                GetConfirmedSignaturesForAddress2Config {
                    before,
                    until: None,
                    limit: Some(PAGE),
                    commitment: Some(CommitmentConfig::confirmed()),
                },
            )
            .await
            .with_context(|| format!("getSignaturesForAddress {program}"))?;
        let next = more(&page, from_slot);
        before = page
            .last()
            .map(|status| Signature::from_str(&status.signature))
            .transpose()
            .context("RPC returned an invalid signature")?;
        all.extend(page);
        if !next {
            return Ok(all);
        }
    }
}

/// Replays every transaction since `from_slot` that touched either program.
/// A transaction that fails is logged with its signature, as the stream logs
/// a dropped one, and the rest still replay.
pub async fn catch_up(
    rpc: &RpcClient,
    processor: &processors::DuskTransactionProcessor,
    cursor: &Mutex<()>,
    from_slot: u64,
) -> Result<Report> {
    let mut signatures = Vec::new();
    for program in [DUSK_PROGRAM_ID, LEVERAGE_DELEGATE_PROGRAM_ID] {
        let program = Pubkey::from_str(program).context("pinned program id")?;
        signatures.extend(signatures_since(rpc, &program, from_slot).await?);
    }
    let missed = plan(signatures, from_slot);
    let mut report = Report {
        from_slot,
        found: missed.len(),
        ..Report::default()
    };
    for transaction in missed {
        let fetched = rpc
            .get_transaction_with_config(
                &Signature::from_str(&transaction.signature).context("planned signature")?,
                RpcTransactionConfig {
                    encoding: Some(UiTransactionEncoding::Base64),
                    commitment: Some(CommitmentConfig::confirmed()),
                    max_supported_transaction_version: Some(0),
                },
            )
            .await;
        let replayed = match fetched {
            Ok(fetched) => {
                let metadata = processors::metadata_from_rpc(&fetched)?;
                // Serialized with the stream's writes and the heartbeat.
                let _cursor = cursor.lock().await;
                processor.replay(&metadata).await
            }
            Err(error) => Err(anyhow::Error::from(error)),
        };
        match replayed {
            Ok(events) => {
                report.replayed += 1;
                report.events += events;
            }
            Err(error) => {
                report.failed += 1;
                log::error!(
                    "catch-up dropped transaction {} at slot {}: {error:#}",
                    transaction.signature,
                    transaction.slot
                );
            }
        }
    }
    Ok(report)
}

/// The slot a gap starts from: the last one written, or the release's first.
pub async fn gap_start(pool: &PgPool, cluster: &str, first_slot: u64) -> Result<u64> {
    Ok(persist::last_observed_slot(pool, cluster)
        .await?
        .unwrap_or(first_slot)
        .max(first_slot))
}

/// Catches up from `since_restart` once the stream first delivers, then
/// again each time it delivers after going quiet. A gap's start is read when
/// the silence begins: after recovery, the stream's own writes would already
/// have moved the cursor past it.
#[allow(clippy::too_many_arguments)]
pub async fn watch(
    rpc: Arc<RpcClient>,
    processor: processors::DuskTransactionProcessor,
    pool: PgPool,
    cluster: String,
    first_slot: u64,
    since_restart: u64,
    liveness: Arc<StreamLiveness>,
    cursor: Arc<Mutex<()>>,
) {
    let mut gap = Some(since_restart);
    let mut wait = CHECK;
    loop {
        tokio::time::sleep(wait).await;
        wait = CHECK;
        if !liveness.live_within(GAP) {
            if gap.is_none() {
                match gap_start(&pool, &cluster, first_slot).await {
                    Ok(slot) => gap = Some(slot),
                    Err(error) => log::warn!("catch-up could not read the cursor: {error:#}"),
                }
            }
            continue;
        }
        let Some(from_slot) = gap else {
            continue;
        };
        match catch_up(&rpc, &processor, &cursor, from_slot).await {
            Ok(report) => {
                log::info!(
                    "catch-up from slot {}: {} transaction(s), {} replayed, {} event(s), {} failed",
                    report.from_slot,
                    report.found,
                    report.replayed,
                    report.events,
                    report.failed
                );
                gap = None;
            }
            // An RPC failure keeps the gap and retries; nothing was skipped.
            Err(error) => {
                log::warn!("catch-up from slot {from_slot} failed: {error:#}; retrying");
                wait = Duration::from_secs(10);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(
        signature: &str,
        slot: u64,
        failed: bool,
    ) -> RpcConfirmedTransactionStatusWithSignature {
        serde_json::from_value(serde_json::json!({
            "signature": signature,
            "slot": slot,
            "err": if failed { serde_json::json!("AccountInUse") } else { serde_json::Value::Null },
            "memo": null,
            "blockTime": null,
            "confirmationStatus": null,
        }))
        .unwrap()
    }

    #[test]
    fn plans_successful_transactions_from_the_gap_oldest_first_once_each() {
        let planned = plan(
            vec![
                // Dusk program page, newest first.
                status("c", 30, false),
                status("b", 20, true),
                status("a", 10, false),
                status("old", 9, false),
                // The delegate lists a transaction that also touched Dusk.
                status("c", 30, false),
                status("d", 25, false),
            ],
            10,
        );
        assert_eq!(
            planned,
            vec![
                Missed {
                    slot: 10,
                    signature: "a".into()
                },
                Missed {
                    slot: 25,
                    signature: "d".into()
                },
                Missed {
                    slot: 30,
                    signature: "c".into()
                },
            ]
        );
    }

    #[test]
    fn pages_until_one_is_short_or_passes_the_gap() {
        let full = |oldest: u64| {
            let mut page = vec![status("x", oldest + 5, false); PAGE - 1];
            page.push(status("y", oldest, false));
            page
        };
        assert!(more(&full(10), 10));
        assert!(!more(&full(9), 10));
        assert!(!more(&[status("x", 50, false)], 10));
        assert!(!more(&[], 10));
    }
}

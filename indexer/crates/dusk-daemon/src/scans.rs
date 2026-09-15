//! Durable finalized scan checkpoints. Coverage is committed only after the
//! shared decoder/persistence path succeeds for every enumerated transaction.
use {
    crate::identity::DeploymentWindow,
    anyhow::{bail, Context as _, Result},
    chrono::{TimeZone, Utc},
    dusk_indexer_foundation::{
        DUSK_IDL_SHA256, DUSK_PROGRAM_ID, LEVERAGE_DELEGATE_IDL_SHA256,
        LEVERAGE_DELEGATE_PROGRAM_ID, PROTOCOL_REVISION,
    },
    sha2::{Digest, Sha256},
    solana_transaction_status::{EncodedConfirmedTransactionWithStatusMeta, EncodedTransaction},
    sqlx::{Postgres, Transaction},
};

pub async fn lock(tx: &mut Transaction<'_, Postgres>, cluster: &str, orders: bool) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!(
                "dusk-history-pass|{cluster}|{PROTOCOL_REVISION}|{orders}"
            ))
            .fetch_one(&mut *tx)
            .await?,
    )
}

pub async fn next_slot(
    tx: &mut Transaction<'_, Postgres>,
    cluster: &str,
    window: DeploymentWindow,
    orders: bool,
) -> Result<u64> {
    let (table, program, hash) = stream(orders);
    let through: Option<i64> = sqlx::query_scalar(&format!("SELECT max(through_slot) FROM dusk_ingestion.{table} WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4"))
        .bind(cluster).bind(program).bind(hash).bind(PROTOCOL_REVISION)
        .fetch_one(&mut *tx).await?;
    match through {
        Some(slot) => {
            let slot = u64::try_from(slot)?;
            window.require_slot(slot)?;
            Ok(slot + 1)
        }
        None => Ok(window.first_slot),
    }
}

// Validate failed transactions too: a signature-list status is not a complete
// transaction receipt. A failed transaction has no committed economic events.
pub fn validate_transaction(
    entry: &solana_client::rpc_response::RpcConfirmedTransactionStatusWithSignature,
    transaction: &EncodedConfirmedTransactionWithStatusMeta,
) -> Result<()> {
    let EncodedTransaction::Json(body) = &transaction.transaction.transaction else {
        bail!("expected JSON-encoded transaction");
    };
    let meta = transaction
        .transaction
        .meta
        .as_ref()
        .context("transaction has no meta")?;
    if transaction.slot != entry.slot
        || body.signatures.first().map(String::as_str) != Some(entry.signature.as_str())
        || meta.err != entry.err
    {
        bail!("FINALIZED_INVARIANT: signature listing and transaction receipt differ");
    }
    Ok(())
}

pub fn transaction_hash(transaction: &EncodedConfirmedTransactionWithStatusMeta) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(transaction)?)
    ))
}

#[allow(clippy::too_many_arguments)]
pub async fn record(
    tx: &mut Transaction<'_, Postgres>,
    cluster: &str,
    window: DeploymentWindow,
    boundary: &(String, u64),
    through_blockhash: &str,
    through_time: i64,
    release_time: i64,
    receipts: &[serde_json::Value],
    orders: bool,
) -> Result<()> {
    let (table, program, hash) = stream(orders);
    sqlx::query(&format!("INSERT INTO dusk_ingestion.{table}(cluster,program_id,idl_hash,protocol_revision,from_slot,through_slot,boundary_signature,boundary_slot,through_blockhash,through_block_time,release_block_time,transactions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)"))
        .bind(cluster).bind(program).bind(hash).bind(PROTOCOL_REVISION)
        .bind(i64::try_from(window.first_slot)?).bind(i64::try_from(window.through_slot)?)
        .bind(&boundary.0).bind(i64::try_from(boundary.1)?).bind(through_blockhash)
        .bind(Utc.timestamp_opt(through_time,0).single().context("invalid history block time")?)
        .bind(Utc.timestamp_opt(release_time,0).single().context("invalid deployment block time")?)
        .bind(serde_json::to_string(receipts)?).execute(&mut *tx).await?;
    Ok(())
}

fn stream(orders: bool) -> (&'static str, &'static str, &'static str) {
    if orders {
        (
            "order_history_scans",
            LEVERAGE_DELEGATE_PROGRAM_ID,
            LEVERAGE_DELEGATE_IDL_SHA256,
        )
    } else {
        ("history_scans", DUSK_PROGRAM_ID, DUSK_IDL_SHA256)
    }
}

#[cfg(test)]
mod tests {
    use {super::*, serde_json::json};
    #[test]
    fn failed_and_successful_receipts_must_match_listing_and_signature() {
        let mut transaction: EncodedConfirmedTransactionWithStatusMeta = serde_json::from_value(json!({
            "slot": 20, "blockTime": 1234,
            "transaction": {"signatures":["receipt"],"message":{"header":{"numRequiredSignatures":1,"numReadonlySignedAccounts":0,"numReadonlyUnsignedAccounts":0},"accountKeys":[],"recentBlockhash":"block","instructions":[]}},
            "meta":{"err":null,"status":{"Ok":null},"fee":5000,"preBalances":[],"postBalances":[],"innerInstructions":[],"logMessages":[]}
        })).unwrap();
        let mut listing: solana_client::rpc_response::RpcConfirmedTransactionStatusWithSignature = serde_json::from_value(json!({
            "signature":"receipt","slot":20,"err":null,"memo":null,"blockTime":1234,"confirmationStatus":"finalized"
        })).unwrap();
        validate_transaction(&listing, &transaction).unwrap();
        listing.slot = 21;
        assert!(validate_transaction(&listing, &transaction).is_err());
        listing.slot = 20;
        listing.signature = "other".to_owned();
        assert!(validate_transaction(&listing, &transaction).is_err());
        listing.signature = "receipt".to_owned();
        listing.err = serde_json::from_value(json!("AccountNotFound")).unwrap();
        assert!(validate_transaction(&listing, &transaction).is_err());
        transaction.transaction.meta.as_mut().unwrap().err = listing.err.clone();
        validate_transaction(&listing, &transaction).unwrap();
        transaction.transaction.meta = None;
        assert!(validate_transaction(&listing, &transaction).is_err());
    }
}


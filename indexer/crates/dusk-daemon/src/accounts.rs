//! A complete finalized account scan is a native Dusk projection input. Raw
//! observations commit first; the same decoder/apply path is used on replay.
use {
    anyhow::{bail, Context, Result},
    base64::{engine::general_purpose::STANDARD, Engine},
    dusk_indexer_foundation::{
        decoder::{AccountDecodeStatus, AccountObservationContext, PinnedIdlDecoder},
        sha256_hex, Commitment, DUSK_IDL_SHA256, DUSK_PROGRAM_ID, LEVERAGE_DELEGATE_IDL_SHA256,
        LEVERAGE_DELEGATE_PROGRAM_ID, PROTOCOL_REVISION,
    },
    serde_json::{json, Value},
    solana_client::{
        nonblocking::rpc_client::RpcClient, rpc_config::RpcBlockConfig, rpc_request::RpcRequest,
    },
    solana_commitment_config::CommitmentConfig,
    solana_transaction_status::{TransactionDetails, UiTransactionEncoding},
    sqlx::PgPool,
    std::{future::Future, time::Duration},
};

async fn read_snapshot_block<T, Read, ReadFuture, Pause, PauseFuture>(
    slot: u64,
    mut read: Read,
    mut pause: Pause,
) -> Result<T>
where
    Read: FnMut(u64) -> ReadFuture,
    ReadFuture: Future<Output = Result<T>>,
    Pause: FnMut(Duration) -> PauseFuture,
    PauseFuture: Future<Output = ()>,
{
    for attempt in 0..4 {
        match read(slot).await {
            Ok(block) => return Ok(block),
            Err(error) if attempt == 3 => return Err(error),
            Err(_) => pause(Duration::from_millis(500 * (attempt + 1))).await,
        }
    }
    unreachable!("the final attempt returns its result")
}

pub async fn capture(
    rpc: &RpcClient,
    pool: &PgPool,
    decoder: &PinnedIdlDecoder,
    cluster: &str,
    attestation: &mut crate::identity::Attestation,
) -> Result<()> {
    for (program, idl_hash) in [
        (DUSK_PROGRAM_ID, DUSK_IDL_SHA256),
        (LEVERAGE_DELEGATE_PROGRAM_ID, LEVERAGE_DELEGATE_IDL_SHA256),
    ] {
        attestation.verify(rpc, cluster).await?;
        let minimum = attestation.window()?.through_slot;
        let response: Value = rpc
            .send(
                RpcRequest::GetProgramAccounts,
                json!([program, {"encoding":"base64","commitment":"finalized","withContext":true,"minContextSlot":minimum}]),
            )
            .await?;
        let slot = response["context"]["slot"]
            .as_u64()
            .context("account scan is missing its context slot")?;
        if slot < minimum {
            bail!("FINALIZED_INVARIANT: account scan predates its deployment attestation");
        }
        let rows = response["value"]
            .as_array()
            .context("account scan is not a complete account array")?;
        // Block-history replicas may lag the finalized account bank. Retry
        // that exact slot; a newer block cannot describe the captured bytes.
        let block = read_snapshot_block(
            slot,
            |slot| async move {
                Ok(rpc
                    .get_block_with_config(
                        slot,
                        RpcBlockConfig {
                            encoding: Some(UiTransactionEncoding::Json),
                            transaction_details: Some(TransactionDetails::None),
                            rewards: Some(false),
                            commitment: Some(CommitmentConfig::finalized()),
                            max_supported_transaction_version: Some(0),
                        },
                    )
                    .await?)
            },
            tokio::time::sleep,
        )
        .await?;
        let mut decoded = Vec::new();
        let mut fingerprints = std::collections::BTreeMap::new();
        for row in rows {
            let address = row["pubkey"].as_str().context("account pubkey missing")?;
            if row["account"]["owner"].as_str() != Some(program) {
                bail!("FINALIZED_INVARIANT: scanned account owner mismatch");
            }
            if row["account"]["data"][1].as_str() != Some("base64") {
                bail!("account scan did not return base64 data");
            }
            let raw_base64 = row["account"]["data"][0]
                .as_str()
                .context("account data missing")?;
            let raw = STANDARD.decode(raw_base64)?;
            let hash = sha256_hex(&raw);
            if fingerprints
                .insert(address.to_owned(), hash.clone())
                .is_some()
            {
                bail!("FINALIZED_INVARIANT: duplicate account in complete scan");
            }
            let context = AccountObservationContext {
                account_pubkey: address.to_owned(),
                transaction_signature: None,
                write_version: None,
                slot,
                blockhash: block.blockhash.clone(),
                parent_slot: Some(block.parent_slot),
                commitment: Commitment::Finalized,
                observed_at_unix_ms: chrono::Utc::now().timestamp_millis() as u64,
                source: "rpc-complete-account-scan".to_owned(),
            };
            let account = decoder.decode_account(&context, program, &raw)?;
            if account.status == AccountDecodeStatus::MalformedKnownPayload
                || account.projection_error.is_some()
            {
                bail!(
                    "known account {address} could not be projected: {:?} {:?}",
                    account.decode_error,
                    account.projection_error
                );
            }
            decoded.push(json!({"account":address,"data_hash":hash,"raw_base64":raw_base64,"account_name":account.account_name,"fields":account.decoded_fields,"projections":account.projections}));
        }
        attestation.verify_at(rpc, cluster, slot).await?;
        let content_hash = sha256_hex(serde_json::to_string(&fingerprints)?.as_bytes());
        persist_scan(
            pool,
            cluster,
            program,
            idl_hash,
            slot,
            &block.blockhash,
            block.parent_slot,
            &content_hash,
            Value::Array(decoded),
        )
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn persist_scan(
    pool: &PgPool,
    cluster: &str,
    program: &str,
    idl_hash: &str,
    slot: u64,
    blockhash: &str,
    parent_slot: u64,
    content_hash: &str,
    decoded: Value,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let scan_id: i64 = sqlx::query_scalar(r#"
      INSERT INTO dusk_ingestion.account_scans (cluster,program_id,idl_hash,protocol_revision,slot,blockhash,parent_slot,content_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (cluster,program_id,idl_hash,protocol_revision,slot,blockhash) DO UPDATE SET content_hash=EXCLUDED.content_hash
      WHERE dusk_ingestion.account_scans.content_hash=EXCLUDED.content_hash AND dusk_ingestion.account_scans.parent_slot=EXCLUDED.parent_slot
      RETURNING scan_id
    "#).bind(cluster).bind(program).bind(idl_hash).bind(PROTOCOL_REVISION).bind(i64::try_from(slot)?).bind(blockhash).bind(i64::try_from(parent_slot)?).bind(content_hash)
      .fetch_optional(&mut tx).await?.context("FINALIZED_INVARIANT: contradictory account snapshot at finalized slot")?;
    let body = decoded.to_string();
    sqlx::query(r#"
      INSERT INTO dusk_ingestion.account_observations (scan_id,account_pubkey,data_hash,raw_account)
      SELECT $1,d->>'account',d->>'data_hash',decode(d->>'raw_base64','base64') FROM jsonb_array_elements($2::jsonb) d
      ON CONFLICT DO NOTHING
    "#).bind(scan_id).bind(&body).execute(&mut tx).await?;
    tx.commit().await?;
    sqlx::query("SELECT dusk_ingestion.apply_account_scan($1,$2::jsonb)")
        .bind(scan_id)
        .bind(&body)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use {super::*, std::future::ready};

    #[tokio::test]
    async fn block_history_lag_retries_the_original_account_bank() {
        let mut slots = Vec::new();
        let mut delays = Vec::new();
        let result = read_snapshot_block(
            77,
            |slot| {
                slots.push(slot);
                ready(if slots.len() < 3 {
                    Err(anyhow::anyhow!("block unavailable"))
                } else {
                    Ok("block 77")
                })
            },
            |delay| {
                delays.push(delay.as_millis());
                ready(())
            },
        )
        .await
        .unwrap();
        assert_eq!(result, "block 77");
        assert_eq!(slots, vec![77, 77, 77]);
        assert_eq!(delays, vec![500, 1000]);
    }

    #[tokio::test]
    async fn unavailable_block_history_stops_after_bounded_attempts() {
        let mut slots = Vec::new();
        let mut delays = Vec::new();
        let result = read_snapshot_block(
            88,
            |slot| {
                slots.push(slot);
                ready(Err::<(), _>(anyhow::anyhow!("block unavailable")))
            },
            |delay| {
                delays.push(delay.as_millis());
                ready(())
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(slots, vec![88, 88, 88, 88]);
        assert_eq!(delays, vec![500, 1000, 1500]);
    }
}

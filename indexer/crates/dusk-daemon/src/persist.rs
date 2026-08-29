//! Postgres persistence for decoded events, cursors, and the hypertable.
//!
//! Finalized-only ingestion writes canonical rows directly: finalized history
//! cannot fork, so the observation is the canonical record. JSON payloads are
//! bound as text and cast to `jsonb` in SQL, which keeps this crate off
//! sqlx's serde feature matrix.

use {
    anyhow::{Context as _, Result},
    chrono::{DateTime, TimeZone, Utc},
    dusk_indexer_foundation::{
        decoder::DecodedEventEnvelope, DUSK_IDL_SHA256, DUSK_PROGRAM_ID,
        LEVERAGE_DELEGATE_IDL_SHA256, LEVERAGE_DELEGATE_PROGRAM_ID, PROTOCOL_REVISION,
    },
    sqlx::PgPool,
};

const STREAM_NAME: &str = "rpc-signature-poll";

/// The identity rows every observation references. One per pinned program.
pub async fn ensure_protocol_identity(pool: &PgPool, cluster: &str) -> Result<()> {
    for (program_id, idl_hash) in [
        (DUSK_PROGRAM_ID, DUSK_IDL_SHA256),
        (LEVERAGE_DELEGATE_PROGRAM_ID, LEVERAGE_DELEGATE_IDL_SHA256),
    ] {
        sqlx::query(
            r#"
            INSERT INTO dusk_ingestion.protocol_identities
                (cluster, program_id, idl_hash, protocol_revision)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(cluster)
        .bind(program_id)
        .bind(idl_hash)
        .bind(PROTOCOL_REVISION)
        .execute(pool)
        .await
        .context("upserting protocol identity")?;
    }
    Ok(())
}

pub async fn load_cursor(pool: &PgPool, cluster: &str) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        r#"
        SELECT last_signature FROM dusk_ingestion.ingestion_cursors
        WHERE cluster = $1 AND program_id = $2 AND idl_hash = $3
          AND protocol_revision = $4 AND stream_name = $5
        "#,
    )
    .bind(cluster)
    .bind(DUSK_PROGRAM_ID)
    .bind(DUSK_IDL_SHA256)
    .bind(PROTOCOL_REVISION)
    .bind(STREAM_NAME)
    .fetch_optional(pool)
    .await
    .context("loading ingestion cursor")?;
    Ok(row.and_then(|(signature,)| signature))
}

pub async fn advance_cursor(
    pool: &PgPool,
    cluster: &str,
    signature: &str,
    slot: u64,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO dusk_ingestion.ingestion_cursors
            (cluster, program_id, idl_hash, protocol_revision, stream_name,
             commitment, next_slot, last_observed_slot, last_finalized_slot,
             last_signature, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'finalized', $6 + 1, $6, $6, $7, now())
        ON CONFLICT (cluster, program_id, idl_hash, protocol_revision, stream_name)
        DO UPDATE SET
            next_slot = GREATEST(dusk_ingestion.ingestion_cursors.next_slot, EXCLUDED.next_slot),
            last_observed_slot = GREATEST(
                COALESCE(dusk_ingestion.ingestion_cursors.last_observed_slot, 0),
                EXCLUDED.last_observed_slot
            ),
            last_finalized_slot = GREATEST(
                COALESCE(dusk_ingestion.ingestion_cursors.last_finalized_slot, 0),
                EXCLUDED.last_finalized_slot
            ),
            last_signature = EXCLUDED.last_signature,
            updated_at = now()
        "#,
    )
    .bind(cluster)
    .bind(DUSK_PROGRAM_ID)
    .bind(DUSK_IDL_SHA256)
    .bind(PROTOCOL_REVISION)
    .bind(STREAM_NAME)
    .bind(slot as i64)
    .bind(signature)
    .execute(pool)
    .await
    .context("advancing ingestion cursor")?;
    Ok(())
}

/// Observation + canonical row + hypertable row, idempotently.
pub async fn persist_event(
    pool: &PgPool,
    event: &DecodedEventEnvelope,
    block_time: Option<i64>,
) -> Result<()> {
    let record = event.canonical_record();
    let decoded_payload = record
        .decoded_payload
        .as_ref()
        .map(|value| value.to_string());
    let instruction_path: Vec<i32> = record
        .instruction_path
        .iter()
        .map(|segment| i32::from(*segment))
        .collect();
    let observed_at: DateTime<Utc> = Utc
        .timestamp_millis_opt(record.observed_at_unix_ms as i64)
        .single()
        .unwrap_or_else(Utc::now);

    let mut transaction = pool.begin().await?;

    let observation_id: i64 = match sqlx::query_scalar(
        r#"
        INSERT INTO dusk_ingestion.event_observations
            (cluster, program_id, idl_hash, protocol_revision, event_key,
             transaction_signature, instruction_path, event_ordinal, slot,
             blockhash, parent_slot, commitment, event_name, payload_hash,
             decoded_payload, raw_event, source, observed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                $15::jsonb, $16, $17, $18)
        ON CONFLICT (cluster, program_id, idl_hash, protocol_revision, event_key, blockhash)
        DO NOTHING
        RETURNING observation_id
        "#,
    )
    .bind(&record.cluster)
    .bind(&record.program_id)
    .bind(&record.idl_hash)
    .bind(&record.protocol_revision)
    .bind(&record.event_key)
    .bind(&record.transaction_signature)
    .bind(&instruction_path)
    .bind(i32::from(record.event_ordinal))
    .bind(record.slot as i64)
    .bind(&record.blockhash)
    .bind(record.parent_slot.map(|slot| slot as i64))
    .bind(commitment_str(record.commitment))
    .bind(&record.event_name)
    .bind(&record.payload_hash)
    .bind(&decoded_payload)
    .bind(&record.raw_event)
    .bind(&record.source)
    .bind(observed_at)
    .fetch_optional(&mut transaction)
    .await
    .context("inserting event observation")?
    {
        Some(id) => id,
        // Already observed for this blockhash — reuse the stored row.
        None => sqlx::query_scalar(
            r#"
            SELECT observation_id FROM dusk_ingestion.event_observations
            WHERE cluster = $1 AND program_id = $2 AND idl_hash = $3
              AND protocol_revision = $4 AND event_key = $5 AND blockhash = $6
            "#,
        )
        .bind(&record.cluster)
        .bind(&record.program_id)
        .bind(&record.idl_hash)
        .bind(&record.protocol_revision)
        .bind(&record.event_key)
        .bind(&record.blockhash)
        .fetch_one(&mut transaction)
        .await
        .context("fetching existing observation")?,
    };

    sqlx::query(
        r#"
        INSERT INTO dusk_ingestion.canonical_events
            (cluster, program_id, idl_hash, protocol_revision, event_key,
             observation_id, commitment)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (cluster, program_id, idl_hash, protocol_revision, event_key)
        DO UPDATE SET
            observation_id = EXCLUDED.observation_id,
            commitment = EXCLUDED.commitment,
            updated_at = now()
        "#,
    )
    .bind(&record.cluster)
    .bind(&record.program_id)
    .bind(&record.idl_hash)
    .bind(&record.protocol_revision)
    .bind(&record.event_key)
    .bind(observation_id)
    .bind(commitment_str(record.commitment))
    .execute(&mut transaction)
    .await
    .context("upserting canonical event")?;

    // Time-series row. Block time is the honest series axis; a missing block
    // time (possible on very recent slots) falls back to observation time.
    let stream_time: DateTime<Utc> = block_time
        .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
        .unwrap_or(observed_at);
    let market = record
        .decoded_payload
        .as_ref()
        .and_then(|payload| payload.get("market"))
        .and_then(|value| value.as_str())
        .map(str::to_owned);
    sqlx::query(
        r#"
        INSERT INTO dusk_ingestion.event_stream
            (time, cluster, program_id, event_name, market,
             transaction_signature, event_key, slot, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (event_key, time) DO NOTHING
        "#,
    )
    .bind(stream_time)
    .bind(&record.cluster)
    .bind(&record.program_id)
    .bind(record.event_name.as_deref().unwrap_or("<unknown>"))
    .bind(&market)
    .bind(&record.transaction_signature)
    .bind(&record.event_key)
    .bind(record.slot as i64)
    .bind(&decoded_payload)
    .execute(&mut transaction)
    .await
    .context("inserting event stream row")?;

    transaction.commit().await?;
    Ok(())
}

fn commitment_str(commitment: dusk_indexer_foundation::Commitment) -> &'static str {
    use dusk_indexer_foundation::Commitment;
    match commitment {
        Commitment::Processed => "processed",
        Commitment::Confirmed => "confirmed",
        Commitment::Finalized => "finalized",
    }
}

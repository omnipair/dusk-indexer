//! Postgres persistence for decoded events, cursors, and the hypertable.
//!
//! Streamed ingestion writes confirmed events as they land, like the v1
//! indexer: the observation is the canonical record and nothing revisits it
//! for forks. JSON payloads are bound as text and cast to `jsonb` in SQL,
//! which keeps this crate off sqlx's serde feature matrix.

use {
    anyhow::{Context as _, Result},
    chrono::{DateTime, TimeZone, Utc},
    dusk_indexer_foundation::{
        decoder::DecodedEventEnvelope, DUSK_IDL_SHA256, DUSK_PROGRAM_ID,
        LEVERAGE_DELEGATE_IDL_SHA256, LEVERAGE_DELEGATE_PROGRAM_ID, PROTOCOL_REVISION,
    },
    sqlx::PgPool,
};

pub const STREAM_NAME: &str = "helius-atlas-ws";

pub async fn record_deployment(
    pool: &PgPool,
    cluster: &str,
    window: crate::identity::DeploymentWindow,
) -> Result<()> {
    let pin = dusk_indexer_foundation::deployment::pinned_deployment()?;
    if pin.cluster.name != cluster || pin.first_slot() != window.first_slot {
        anyhow::bail!(
            "FINALIZED_INVARIANT: deployment registration differs from compiled identity"
        );
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT dusk_ingestion.record_deployment_interval($1,$2,$3,$4,$5,$6)")
        .bind(cluster)
        .bind(PROTOCOL_REVISION)
        .bind(i64::try_from(window.first_slot)?)
        .bind(i64::try_from(window.through_slot)?)
        .bind(pin.sha256())
        .bind(pin.payload())
        .execute(&mut tx)
        .await?;
    sqlx::query("INSERT INTO dusk_ingestion.ingestion_cursors (cluster,program_id,idl_hash,protocol_revision,stream_name,commitment,next_slot) VALUES ($1,$2,$3,$4,$5,'confirmed',$6) ON CONFLICT DO NOTHING")
        .bind(cluster).bind(DUSK_PROGRAM_ID).bind(DUSK_IDL_SHA256).bind(PROTOCOL_REVISION).bind(STREAM_NAME)
        .bind(i64::try_from(window.first_slot)?).execute(&mut tx).await?;
    tx.commit().await?;
    Ok(())
}

/// The identity rows every observation references. One per pinned program.
pub async fn ensure_protocol_identity(pool: &PgPool, cluster: &str) -> Result<()> {
    for (program_id, idl_hash) in [
        (DUSK_PROGRAM_ID, DUSK_IDL_SHA256),
        (LEVERAGE_DELEGATE_PROGRAM_ID, LEVERAGE_DELEGATE_IDL_SHA256),
    ] {
        let reused: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM dusk_ingestion.protocol_identities WHERE cluster=$1 AND program_id=$2 AND protocol_revision=$3 AND idl_hash<>$4)")
            .bind(cluster).bind(program_id).bind(PROTOCOL_REVISION).bind(idl_hash).fetch_one(pool).await?;
        if reused {
            anyhow::bail!(
                "FINALIZED_INVARIANT: protocol revision reused with a different IDL hash"
            );
        }
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

/// Touch the cursor's `updated_at` without moving it.
///
/// The cursor otherwise advances only when a poll finds transactions, so on a
/// quiet market a healthy daemon and a dead one look identical from the
/// database — both leave an old cursor and a growing slot lag. A heartbeat on
/// every poll makes the cursor's age a liveness signal rather than a measure
/// of how recently somebody traded.
pub async fn touch_cursor(pool: &PgPool, cluster: &str) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE dusk_ingestion.ingestion_cursors
           SET updated_at = now()
         WHERE cluster = $1 AND program_id = $2 AND idl_hash = $3
           AND protocol_revision = $4 AND stream_name = $5
        "#,
    )
    .bind(cluster)
    .bind(DUSK_PROGRAM_ID)
    .bind(DUSK_IDL_SHA256)
    .bind(PROTOCOL_REVISION)
    .bind(STREAM_NAME)
    .execute(pool)
    .await
    .context("touching ingestion cursor")?;
    Ok(())
}

pub async fn advance_cursor(
    pool: &PgPool,
    cluster: &str,
    signature: &str,
    slot: u64,
    first_slot: u64,
) -> Result<()> {
    require_release_slot(slot, first_slot)?;
    sqlx::query(
        r#"
        INSERT INTO dusk_ingestion.ingestion_cursors
            (cluster, program_id, idl_hash, protocol_revision, stream_name,
             commitment, next_slot, last_observed_slot, last_signature, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'confirmed', $6 + 1, $6, $7, now())
        ON CONFLICT (cluster, program_id, idl_hash, protocol_revision, stream_name)
        DO UPDATE SET
            next_slot = GREATEST(dusk_ingestion.ingestion_cursors.next_slot, EXCLUDED.next_slot),
            last_observed_slot = GREATEST(
                COALESCE(dusk_ingestion.ingestion_cursors.last_observed_slot, 0),
                EXCLUDED.last_observed_slot
            ),
            last_signature = EXCLUDED.last_signature,
            updated_at = now()
        WHERE dusk_ingestion.ingestion_cursors.last_observed_slot IS NULL
           OR dusk_ingestion.ingestion_cursors.last_observed_slot <= EXCLUDED.last_observed_slot
        "#,
    )
    .bind(cluster)
    .bind(DUSK_PROGRAM_ID)
    .bind(DUSK_IDL_SHA256)
    .bind(PROTOCOL_REVISION)
    .bind(STREAM_NAME)
    .bind(i64::try_from(slot)?)
    .bind(signature)
    .execute(pool)
    .await
    .context("advancing ingestion cursor")?;
    Ok(())
}

/// Events before the pinned release belong to another deployment.
pub fn require_release_slot(slot: u64, first_slot: u64) -> Result<()> {
    if slot < first_slot {
        anyhow::bail!("slot {slot} precedes the pinned release at {first_slot}");
    }
    Ok(())
}

/// Observation + canonical row + hypertable row, idempotently. `time` is the
/// block time when the source provides one and arrival time otherwise, as in
/// the v1 indexer.
pub async fn persist_event(
    pool: &PgPool,
    event: &DecodedEventEnvelope,
    stream_time: DateTime<Utc>,
    first_slot: u64,
) -> Result<()> {
    require_release_slot(event.observation.slot, first_slot)?;
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
              AND payload_hash = $7 AND slot = $8 AND parent_slot IS NOT DISTINCT FROM $9
              AND decoded_payload IS NOT DISTINCT FROM $10::jsonb AND raw_event IS NOT DISTINCT FROM $11
              AND commitment = $14 AND instruction_path = $12 AND event_ordinal = $13
            "#,
        )
        .bind(&record.cluster)
        .bind(&record.program_id)
        .bind(&record.idl_hash)
        .bind(&record.protocol_revision)
        .bind(&record.event_key)
        .bind(&record.blockhash)
        .bind(&record.payload_hash).bind(record.slot as i64).bind(record.parent_slot.map(|slot| slot as i64))
        .bind(&decoded_payload).bind(&record.raw_event).bind(&instruction_path).bind(i32::from(record.event_ordinal))
        .bind(commitment_str(record.commitment))
        .fetch_optional(&mut transaction).await?
        .context("repeated observation has contradictory chain facts")?,
    };

    // Commit the observation before canonical projection, so a contradictory
    // candidate stays available for diagnosis.
    transaction.commit().await?;
    let mut transaction = pool.begin().await?;
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

    // Event time orders history; observation time is diagnostic.
    let market = record
        .decoded_payload
        .as_ref()
        .and_then(|payload| payload.get("market"))
        .and_then(|value| value.as_str())
        .map(str::to_owned);
    // One stream row per event. Arrival time differs on redelivery, so the
    // (event_key, time) key alone would admit a second row; the event key
    // decides, under a lock so a concurrent replay cannot race the stream.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&record.event_key)
        .execute(&mut transaction)
        .await?;
    sqlx::query(
        r#"
        INSERT INTO dusk_ingestion.event_stream
            (time, cluster, program_id, event_name, market,
             transaction_signature, event_key, slot, payload, idl_hash, protocol_revision)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11
        WHERE NOT EXISTS (
            SELECT 1 FROM dusk_ingestion.event_stream WHERE event_key = $7
        )
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
    .bind(&record.idl_hash)
    .bind(&record.protocol_revision)
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

#[cfg(test)]
mod tests {
    use super::require_release_slot;

    /// Confirmed events stream past the last attested finalized slot; only the
    /// release's first slot bounds them.
    #[test]
    fn only_slots_before_the_release_are_refused() {
        assert!(require_release_slot(19, 20).is_err());
        require_release_slot(20, 20).unwrap();
        require_release_slot(u64::MAX, 20).unwrap();
    }
}

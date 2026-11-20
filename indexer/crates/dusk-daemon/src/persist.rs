//! Postgres persistence for decoded events, cursors, and the hypertable.
//!
//! Observations commit before canonical projections. All events from one
//! transaction are published together; the number of database round trips
//! does not grow with its CPI/event count. Fork changes require reconciliation
//! rather than replacing a canonical pointer from arrival order.

use {
    anyhow::{Context as _, Result},
    chrono::{DateTime, TimeZone, Utc},
    dusk_indexer_foundation::{
        decoder::DecodedEventEnvelope, DUSK_IDL_SHA256, DUSK_PROGRAM_ID,
        LEVERAGE_DELEGATE_IDL_SHA256, LEVERAGE_DELEGATE_PROGRAM_ID, PROTOCOL_REVISION,
    },
    serde_json::{json, Value},
    sqlx::PgPool,
    std::collections::BTreeSet,
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

/// Set the cursor's time: every transaction that arrived before `at` is
/// written. The API serves this as history coverage and `/status` as
/// liveness, so it is set only after a transaction's writes or by the
/// heartbeat while the WebSocket is delivering, both under the cursor lock.
pub async fn touch_cursor(pool: &PgPool, cluster: &str, at: DateTime<Utc>) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE dusk_ingestion.ingestion_cursors
           SET updated_at = $6
         WHERE cluster = $1 AND program_id = $2 AND idl_hash = $3
           AND protocol_revision = $4 AND stream_name = $5
        "#,
    )
    .bind(cluster)
    .bind(DUSK_PROGRAM_ID)
    .bind(DUSK_IDL_SHA256)
    .bind(PROTOCOL_REVISION)
    .bind(STREAM_NAME)
    .bind(at)
    .execute(pool)
    .await
    .context("touching ingestion cursor")?;
    Ok(())
}

/// Raise the cursor's slot to a transaction's. Its time is `touch_cursor`'s.
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
             commitment, next_slot, last_observed_slot, last_signature)
        VALUES ($1, $2, $3, $4, $5, 'confirmed', $6 + 1, $6, $7)
        ON CONFLICT (cluster, program_id, idl_hash, protocol_revision, stream_name)
        DO UPDATE SET
            next_slot = GREATEST(dusk_ingestion.ingestion_cursors.next_slot, EXCLUDED.next_slot),
            last_observed_slot = GREATEST(
                COALESCE(dusk_ingestion.ingestion_cursors.last_observed_slot, 0),
                EXCLUDED.last_observed_slot
            ),
            last_signature = EXCLUDED.last_signature
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

/// The highest slot the stream or a replay has written for this release.
pub async fn last_observed_slot(pool: &PgPool, cluster: &str) -> Result<Option<u64>> {
    let slot: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT last_observed_slot FROM dusk_ingestion.ingestion_cursors
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
    .context("reading ingestion cursor")?
    .flatten();
    slot.map(u64::try_from)
        .transpose()
        .context("negative cursor slot")
}

/// Events before the pinned release belong to another deployment.
pub fn require_release_slot(slot: u64, first_slot: u64) -> Result<()> {
    if slot < first_slot {
        anyhow::bail!("slot {slot} precedes the pinned release at {first_slot}");
    }
    Ok(())
}

/// The single-event entry point shares the exact same batched path as live
/// ingestion. Retirement replay must not acquire different write semantics.
pub async fn persist_event(
    pool: &PgPool,
    event: &DecodedEventEnvelope,
    stream_time: DateTime<Utc>,
    first_slot: u64,
) -> Result<()> {
    persist_events(pool, std::slice::from_ref(event), stream_time, first_slot).await
}

fn batch_records(events: &[DecodedEventEnvelope], first_slot: u64) -> Result<Vec<Value>> {
    let mut keys = BTreeSet::new();
    events.iter().map(|event| {
        require_release_slot(event.observation.slot, first_slot)?;
        let record = event.canonical_record();
        if !keys.insert(record.event_key.clone()) {
            anyhow::bail!("duplicate event identity within one transaction");
        }
        let observed_at = Utc.timestamp_millis_opt(i64::try_from(record.observed_at_unix_ms)?)
            .single().context("invalid event observation time")?;
        Ok(json!({
            "cluster": record.cluster, "program_id": record.program_id,
            "idl_hash": record.idl_hash, "protocol_revision": record.protocol_revision,
            "event_key": record.event_key, "transaction_signature": record.transaction_signature,
            "instruction_path": record.instruction_path, "event_ordinal": record.event_ordinal,
            "slot": i64::try_from(record.slot)?, "blockhash": record.blockhash,
            "parent_slot": record.parent_slot.map(i64::try_from).transpose()?,
            "commitment": commitment_str(record.commitment), "event_name": record.event_name,
            "payload_hash": record.payload_hash, "decoded_payload": record.decoded_payload,
            // PostgreSQL's bytea text input; JSON arrays are not bytea values.
            "raw_event": format!("\\x{}", record.raw_event.iter().map(|b| format!("{b:02x}")).collect::<String>()),
            "source": record.source, "observed_at": observed_at,
        }))
    }).collect()
}

/// Persist the observation archive first, then publish the whole transaction's
/// canonical events and history atomically. A six-event swap takes the same
/// fixed number of database round trips as a single-event transaction.
pub async fn persist_events(
    pool: &PgPool,
    events: &[DecodedEventEnvelope],
    stream_time: DateTime<Utc>,
    first_slot: u64,
) -> Result<()> {
    let mut records = batch_records(events, first_slot)?;
    if records.is_empty() {
        return Ok(());
    }
    let payload = serde_json::to_string(&records)?;
    let mut transaction = pool.begin().await?;
    let observations: Vec<(String, i64)> = sqlx::query_as(
        r#"
        INSERT INTO dusk_ingestion.event_observations AS stored
            (cluster,program_id,idl_hash,protocol_revision,event_key,
             transaction_signature,instruction_path,event_ordinal,slot,blockhash,
             parent_slot,commitment,event_name,payload_hash,decoded_payload,raw_event,source,observed_at)
        SELECT cluster,program_id,idl_hash,protocol_revision,event_key,
               transaction_signature,instruction_path,event_ordinal,slot,blockhash,
               parent_slot,commitment,event_name,payload_hash,decoded_payload,raw_event,source,observed_at
        FROM jsonb_to_recordset($1::jsonb) AS batch(
            cluster text,program_id text,idl_hash text,protocol_revision text,event_key text,
            transaction_signature text,instruction_path integer[],event_ordinal integer,slot bigint,
            blockhash text,parent_slot bigint,commitment text,event_name text,payload_hash text,
            decoded_payload jsonb,raw_event bytea,source text,observed_at timestamptz)
        ORDER BY event_key
        ON CONFLICT (cluster,program_id,idl_hash,protocol_revision,event_key,blockhash)
        DO UPDATE SET event_key = stored.event_key
        WHERE stored.payload_hash = EXCLUDED.payload_hash AND stored.slot = EXCLUDED.slot
          AND stored.parent_slot IS NOT DISTINCT FROM EXCLUDED.parent_slot
          AND stored.decoded_payload IS NOT DISTINCT FROM EXCLUDED.decoded_payload
          AND stored.raw_event IS NOT DISTINCT FROM EXCLUDED.raw_event
          AND stored.commitment = EXCLUDED.commitment
          AND stored.instruction_path = EXCLUDED.instruction_path
          AND stored.event_ordinal = EXCLUDED.event_ordinal
          AND stored.transaction_signature = EXCLUDED.transaction_signature
          AND stored.event_name IS NOT DISTINCT FROM EXCLUDED.event_name
        RETURNING event_key,observation_id
        "#
    ).bind(&payload).fetch_all(&mut transaction).await
        .context("persisting transaction observations")?;
    if observations.len() != records.len() {
        anyhow::bail!("repeated observation has contradictory chain facts");
    }
    transaction.commit().await?;

    let ids: std::collections::BTreeMap<_, _> = observations.into_iter().collect();
    for record in &mut records {
        record["observation_id"] = json!(ids[record["event_key"].as_str().unwrap()]);
    }
    let payload = serde_json::to_string(&records)?;
    let mut transaction = pool.begin().await?;
    // Serialize replay and stream writes in stable order, before checking
    // canonical pointers or deduplicating hypertable rows.
    sqlx::query(
        r#"
        SELECT pg_advisory_xact_lock(lock_key) FROM (
            SELECT DISTINCT hashtextextended(event_key,0) AS lock_key
            FROM jsonb_to_recordset($1::jsonb) AS batch(event_key text)
            ORDER BY lock_key
        ) AS locks
    "#,
    )
    .bind(&payload)
    .execute(&mut transaction)
    .await?;
    let written = sqlx::query(r#"
        INSERT INTO dusk_ingestion.canonical_events AS stored
            (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment)
        SELECT cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment
        FROM jsonb_to_recordset($1::jsonb) AS batch(
            cluster text,program_id text,idl_hash text,protocol_revision text,event_key text,
            observation_id bigint,commitment text)
        ORDER BY event_key
        ON CONFLICT (cluster,program_id,idl_hash,protocol_revision,event_key)
        DO UPDATE SET commitment = CASE
            WHEN stored.commitment = 'finalized' THEN 'finalized'
            WHEN stored.commitment = 'confirmed' AND EXCLUDED.commitment = 'processed' THEN 'confirmed'
            ELSE EXCLUDED.commitment END, updated_at = now()
        WHERE stored.observation_id = EXCLUDED.observation_id
    "#).bind(&payload).execute(&mut transaction).await
        .context("publishing transaction canonical events")?;
    if written.rows_affected() != records.len() as u64 {
        anyhow::bail!(
            "FINALIZED_INVARIANT: canonical observation differs; reconciliation required"
        );
    }
    sqlx::query(r#"
        INSERT INTO dusk_ingestion.event_stream
            (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,
             payload,idl_hash,protocol_revision)
        SELECT $2,cluster,program_id,COALESCE(event_name,'<unknown>'),decoded_payload->>'market',
               transaction_signature,event_key,slot,decoded_payload,idl_hash,protocol_revision
        FROM jsonb_to_recordset($1::jsonb) AS batch(
            cluster text,program_id text,idl_hash text,protocol_revision text,event_key text,
            event_name text,decoded_payload jsonb,transaction_signature text,slot bigint)
        WHERE NOT EXISTS (
            SELECT 1 FROM dusk_ingestion.event_stream AS stored WHERE stored.event_key = batch.event_key
        )
    "#).bind(&payload).bind(stream_time).execute(&mut transaction).await
        .context("publishing transaction history")?;
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
    use {
        super::*,
        dusk_indexer_foundation::{
            decoder::{EventDecodeStatus, EventTransport, PinnedProgram},
            CanonicalEventKey, Commitment, EventObservation, ProtocolIdentity,
        },
    };

    fn event(cluster: &str, ordinal: u16) -> DecodedEventEnvelope {
        let identity =
            ProtocolIdentity::new(cluster, DUSK_PROGRAM_ID, DUSK_IDL_SHA256, PROTOCOL_REVISION)
                .unwrap();
        DecodedEventEnvelope {
            program: PinnedProgram::Dusk,
            event_name: Some("SwapExecuted".into()),
            discriminator: None,
            status: EventDecodeStatus::Decoded,
            transport: EventTransport::AnchorEventCpi,
            raw_envelope: vec![0, 128, 255],
            raw_event: vec![0, 128, 255],
            payload: vec![],
            decoded_fields: Some(json!({"market":"batch-test-market", "ordinal":ordinal})),
            decode_error: None,
            observation: EventObservation {
                key: CanonicalEventKey::new(identity, "batch-test-signature", vec![3, ordinal], 0)
                    .unwrap(),
                slot: 20,
                blockhash: "batch-test-block".into(),
                parent_slot: Some(19),
                commitment: Commitment::Confirmed,
                payload_hash: "a".repeat(64),
                observed_at_unix_ms: 1_795_000_000_000,
                source: STREAM_NAME.into(),
            },
        }
    }

    #[test]
    fn batch_validates_every_event_before_writing() {
        let first = event("batch-unit-test", 0);
        let mut second = event("batch-unit-test", 1);
        assert!(batch_records(&[], 20).unwrap().is_empty());
        let records = batch_records(&[first.clone(), second.clone()], 20).unwrap();
        assert_eq!(records[0]["raw_event"], "\\x0080ff");
        assert_eq!(records[1]["instruction_path"], json!([3, 1]));
        assert!(batch_records(&[first.clone(), first.clone()], 20).is_err());
        second.observation.slot = 19;
        assert!(batch_records(&[first, second], 20).is_err());
    }

    /// Runs against an already migrated disposable database, after migrations
    /// in CI.
    #[tokio::test]
    #[ignore = "requires migrated disposable PostgreSQL; CI runs explicitly"]
    async fn postgres_batch_is_atomic_idempotent_and_preserves_observations() {
        assert_eq!(
            std::env::var("DUSK_ALLOW_DISPOSABLE_DB_TESTS").as_deref(),
            Ok("true")
        );
        let pool = PgPool::connect(&std::env::var("DATABASE_URL").expect("DATABASE_URL"))
            .await
            .unwrap();
        let cluster = format!(
            "batch-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        );
        ensure_protocol_identity(&pool, &cluster).await.unwrap();
        let events: Vec<_> = (0..7).map(|n| event(&cluster, n)).collect();
        let time = Utc.timestamp_opt(1_795_000_000, 0).unwrap();
        persist_events(&pool, &events, time, 20).await.unwrap();
        let (observations,canonical,stream,publication_times): (i64,i64,i64,i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM dusk_ingestion.event_observations WHERE cluster=$1),            (SELECT count(*) FROM dusk_ingestion.canonical_events WHERE cluster=$1),            (SELECT count(*) FROM dusk_ingestion.event_stream WHERE cluster=$1),            (SELECT count(DISTINCT canonical_since) FROM dusk_ingestion.canonical_events WHERE cluster=$1)"
        ).bind(&cluster).fetch_one(&pool).await.unwrap();
        assert_eq!(
            (observations, canonical, stream, publication_times),
            (7, 7, 7, 1)
        );
        // Redelivery changes arrival time, never stream identity or original time.
        let mut replay = events.clone();
        for e in &mut replay {
            e.observation.observed_at_unix_ms += 1234;
        }
        let (a, b) = tokio::join!(
            persist_events(&pool, &replay, time + chrono::Duration::seconds(5), 20),
            persist_events(&pool, &events, time, 20)
        );
        a.unwrap();
        b.unwrap();
        let (count, original_time): (i64, DateTime<Utc>) = sqlx::query_as(
            "SELECT count(*),min(time) FROM dusk_ingestion.event_stream WHERE cluster=$1",
        )
        .bind(&cluster)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 7);
        assert_eq!(original_time, time);
        let raw: Vec<u8> = sqlx::query_scalar(
            "SELECT raw_event FROM dusk_ingestion.event_observations WHERE cluster=$1 LIMIT 1",
        )
        .bind(&cluster)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(raw, vec![0, 128, 255]);
        // A different fork is archived but cannot replace a canonical pointer.
        let mut fork = events[0].clone();
        fork.observation.blockhash = "different-block".into();
        let new = event(&cluster, 8);
        let error = persist_events(&pool, &[new.clone(), fork], time, 20)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("reconciliation required"));
        let (observations,canonical,stream): (i64,i64,i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM dusk_ingestion.event_observations WHERE cluster=$1),            (SELECT count(*) FROM dusk_ingestion.canonical_events WHERE cluster=$1),            (SELECT count(*) FROM dusk_ingestion.event_stream WHERE cluster=$1)"
        ).bind(&cluster).fetch_one(&pool).await.unwrap();
        assert_eq!((observations, canonical, stream), (9, 7, 7));
        // A contradiction on a previously observed block is refused as a batch.
        let mut contradiction = events[0].clone();
        contradiction.observation.payload_hash = "b".repeat(64);
        assert!(
            persist_events(&pool, &[new.clone(), contradiction], time, 20)
                .await
                .is_err()
        );
        // Failure after observations commit does not poison later valid replay.
        persist_events(&pool, &[new], time, 20).await.unwrap();
        // Test namespace only. No reset, truncate, or changes to other identities.
        for table in [
            "event_stream",
            "canonical_events",
            "event_observations",
            "protocol_identities",
        ] {
            sqlx::query(&format!(
                "DELETE FROM dusk_ingestion.{table} WHERE cluster=$1"
            ))
            .bind(&cluster)
            .execute(&pool)
            .await
            .unwrap();
        }
        pool.close().await;
    }

    /// Confirmed events stream past the last attested finalized slot; only the
    /// release's first slot bounds them.
    #[test]
    fn only_slots_before_the_release_are_refused() {
        assert!(require_release_slot(19, 20).is_err());
        require_release_slot(20, 20).unwrap();
        require_release_slot(u64::MAX, 20).unwrap();
    }
}

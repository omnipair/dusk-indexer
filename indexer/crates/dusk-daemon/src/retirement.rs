//! Explicit replay of the reviewed retirement interval. Never advances the live
//! cursor or manufactures the local model's ordinary swaps/repays/closes.
use {
    crate::{extract, persist, processors},
    anyhow::{bail, Context as _, Result},
    base64::{engine::general_purpose::STANDARD, Engine as _},
    chrono::{TimeZone as _, Utc},
    dusk_indexer_foundation::{
        canonical_json,
        decoder::{DecodedEventEnvelope, PinnedIdlDecoder},
        retirement_release, sha256_hex, Commitment,
    },
    serde_json::{json, Value},
    solana_client::{
        nonblocking::rpc_client::RpcClient,
        rpc_config::{RpcBlockConfig, RpcTransactionConfig},
    },
    solana_commitment_config::CommitmentConfig,
    solana_pubkey::Pubkey,
    solana_signature::Signature,
    solana_transaction_status::{
        EncodedConfirmedTransactionWithStatusMeta, TransactionDetails, UiTransactionEncoding,
    },
    sqlx::PgPool,
    std::{collections::BTreeSet, io::Read as _, str::FromStr},
};

fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing retirement {name}"))
}
fn number(value: &Value, name: &str) -> Result<u64> {
    value[name]
        .as_u64()
        .filter(|v| *v <= 9_007_199_254_740_991)
        .with_context(|| format!("invalid retirement {name}"))
}
fn digest(value: &Value) -> String {
    sha256_hex(canonical_json(value).as_bytes())
}
fn amount(value: &Value) -> Result<u64> {
    let s = value
        .as_str()
        .context("retirement amount is not an exact integer")?;
    let n = s.parse::<u64>()?;
    if n.to_string() != s {
        bail!("noncanonical retirement amount");
    }
    Ok(n)
}
fn manifest_hash(value: &Value) -> Result<String> {
    let hash = value
        .as_str()
        .and_then(|v| v.strip_prefix("0x"))
        .context("missing decoded begin manifest hash")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
    {
        bail!("invalid begin manifest hash");
    }
    Ok(hash.to_owned())
}

fn checked_archive(mut archive: Value) -> Result<Value> {
    let seal = text(&archive, "contentSha256")?.to_owned();
    archive
        .as_object_mut()
        .context("archive object required")?
        .remove("contentSha256");
    if digest(&archive) != seal {
        bail!("retirement archive seal differs");
    }
    archive["contentSha256"] = json!(seal);
    let pin = retirement_release();
    if archive["schemaVersion"] != "dusk-retirement-receipt-archive.v2"
        || archive["localOnly"] != false
        || archive["readOnly"] != true
        || archive["sourceCommit"] != pin["sourceCommit"]
        || archive["bundleSha256"] != pin["bundleSha256"]
        || archive["protocolIdentity"]
            != json!({"cluster":pin["cluster"],"genesisHash":pin["genesisHash"],
            "programId":pin["programId"],"idlHash":pin["idlCanonicalSha256"],"protocolRevision":pin["protocolRevision"]})
        || digest(&archive["generatedIdl"]) != pin["idlCanonicalSha256"].as_str().unwrap()
        || archive["verified"]["completed"] != true
        || archive["verified"]["masks"] != json!([63, 63])
        || archive["usersPaid"] != 6
        || archive["treasuryPaid"] != true
    {
        bail!("retirement archive is not the exact reviewed actual release");
    }
    let deploy = number(&archive["deployment"], "deploySlot")?;
    let before = number(&archive["deployment"], "slot")?;
    let through = number(&archive, "verifiedThroughSlot")?;
    if deploy == 0 || before <= deploy || through < before {
        bail!("invalid retirement deployment interval");
    }
    let observations = archive["observations"]
        .as_array()
        .context("missing observations")?;
    if observations.is_empty()
        || observations.len() > 10_000
        || digest(&archive["observations"]) != text(&archive, "observationsSha256")?
    {
        bail!("invalid bounded retirement observations");
    }
    Ok(archive)
}

/// All expected beneficiary receipts must be actual canonical helper events.
/// This verifies terminal transfers, not the off-chain economic quote model.
fn validate_events(archive: &Value, events: &[DecodedEventEnvelope]) -> Result<()> {
    let pin = retirement_release();
    let owners: BTreeSet<_> = pin["owners"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let mut cleared = BTreeSet::new();
    let mut paid = BTreeSet::new();
    let mut custody: Option<[u64; 2]> = None;
    let mut total = [0_u128; 2];
    let mut keys = BTreeSet::new();
    let mut treasury_paid = false;
    let mut frozen_slot = None;
    for event in events {
        let record = event.canonical_record();
        if record.cluster != pin["cluster"].as_str().unwrap()
            || record.program_id != pin["programId"].as_str().unwrap()
            || record.idl_hash != pin["idlCanonicalSha256"].as_str().unwrap()
            || record.protocol_revision != pin["protocolRevision"].as_str().unwrap()
            || record.commitment != Commitment::Finalized
            || !keys.insert(record.event_key)
        {
            bail!("retirement event identity differs or repeats");
        }
        let fields = event
            .decoded_fields
            .as_ref()
            .context("retirement event did not decode")?;
        match event.event_name.as_deref() {
            Some("LegacyMarketFrozen") => {
                if frozen_slot.is_some()
                    || custody.is_some()
                    || amount(&fields["slot"])? != record.slot
                {
                    bail!("retirement freeze receipt differs");
                }
                frozen_slot = Some(record.slot);
            }
            Some("LegacyRetirementBegun") => {
                if custody.is_some()
                    || frozen_slot.is_none()
                    || manifest_hash(&fields["manifest_sha256"])?
                        != text(archive, "onChainManifestSha256")?
                    || fields["source_slot"]
                        .as_str()
                        .context("missing source slot")?
                        .parse::<u64>()?
                        >= record.slot
                {
                    bail!("retirement begin receipt differs");
                }
                custody = Some([
                    amount(&fields["custody"][0])?,
                    amount(&fields["custody"][1])?,
                ]);
            }
            Some("LegacyOwnerCleared") => {
                let owner = text(fields, "owner")?;
                if custody.is_none()
                    || !owners.contains(owner)
                    || !cleared.insert(owner.to_owned())
                    || !paid.is_empty()
                {
                    bail!("retirement owner-clear receipt differs");
                }
            }
            Some("LegacyRetirementPaid") => {
                let owner = text(fields, "owner")?;
                let treasury = fields["treasury"]
                    .as_bool()
                    .context("missing beneficiary role")?;
                if cleared != owners
                    || treasury_paid
                    || (treasury && (owner != pin["treasury"].as_str().unwrap() || paid != owners))
                    || (!treasury && (!owners.contains(owner) || !paid.insert(owner.to_owned())))
                {
                    bail!("retirement payout beneficiary/order differs");
                }
                total[0] += u128::from(amount(&fields["base"])?);
                total[1] += u128::from(amount(&fields["quote"])?);
                treasury_paid = treasury;
            }
            _ => bail!("unexpected event in terminal retirement archive"),
        }
    }
    if events.len() != 15
        || cleared != owners
        || paid != owners
        || !treasury_paid
        || custody.map(|v| [u128::from(v[0]), u128::from(v[1])]) != Some(total)
    {
        bail!("incomplete or nonconserving retirement receipts");
    }
    Ok(())
}

fn verify_program_data(data: &[u8], deploy: u64) -> Result<()> {
    let pin = retirement_release();
    let size = pin["binarySize"].as_u64().unwrap() as usize;
    if data.len() < 45 + size
        || data[..4] != 3_u32.to_le_bytes()
        || data[12] != 1
        || u64::from_le_bytes(data[4..12].try_into()?) != deploy
        || Pubkey::new_from_array(data[13..45].try_into()?).to_string()
            != pin["authority"].as_str().unwrap()
        || sha256_hex(&data[45..45 + size]) != pin["binarySha256"].as_str().unwrap()
        || data[45 + size..].iter().any(|b| *b != 0)
    {
        bail!("actual temporary executable/authority differs");
    }
    Ok(())
}
async fn observe_rpc(
    pool: &PgPool,
    archive: &Value,
    kind: &str,
    key: &str,
    payload: Value,
) -> Result<()> {
    let pin = retirement_release();
    sqlx::query("INSERT INTO dusk_ingestion.retirement_rpc_observations(cluster,program_id,idl_hash,protocol_revision,archive_sha256,kind,request_key,payload_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING")
        .bind(text(&pin,"cluster")?).bind(text(&pin,"programId")?).bind(text(&pin,"idlCanonicalSha256")?).bind(text(&pin,"protocolRevision")?)
        .bind(text(archive,"contentSha256")?).bind(kind).bind(key).bind(digest(&payload)).bind(payload.to_string()).execute(pool).await?;
    Ok(())
}
fn upgradeable_loader() -> Result<Pubkey> {
    Pubkey::from_str(crate::identity::UPGRADEABLE_LOADER)
        .context("parsing the canonical upgradeable loader")
}

async fn attest(pool: &PgPool, rpc: &RpcClient, archive: &Value) -> Result<()> {
    let pin = retirement_release();
    let program = Pubkey::from_str(pin["programId"].as_str().unwrap())?;
    let data_key = Pubkey::from_str(pin["programData"].as_str().unwrap())?;
    let loader = upgradeable_loader()?;
    let base = Pubkey::find_program_address(&[], &program).0;
    let idl_key = Pubkey::create_with_seed(&base, "anchor:idl", &program)?;
    let rows = rpc
        .get_multiple_accounts(&[program, data_key, idl_key])
        .await?;
    observe_rpc(pool,archive,"deployment",&number(&archive["deployment"],"deploySlot")?.to_string(),json!({
        "addresses":[program.to_string(),data_key.to_string(),idl_key.to_string()],
        "accounts":rows.iter().map(|a|a.as_ref().map(|a|json!({"owner":a.owner.to_string(),"data":STANDARD.encode(&a.data),
            "executable":a.executable,"lamports":a.lamports,"rentEpoch":a.rent_epoch.to_string()}))).collect::<Vec<_>>()
    })).await?;
    let p = rows[0].as_ref().context("temporary program missing")?;
    let d = rows[1].as_ref().context("temporary ProgramData missing")?;
    let idl = rows[2].as_ref().context("temporary IDL missing")?;
    if p.owner != loader
        || !p.executable
        || p.data.len() != 36
        || p.data[..4] != 2_u32.to_le_bytes()
        || p.data[4..] != data_key.to_bytes()
        || d.owner != loader
        || d.executable
        || idl.owner != program
        || idl.executable
        || idl.data.len() < 44
        || idl.data[8..40] != Pubkey::from_str(pin["authority"].as_str().unwrap())?.to_bytes()
    {
        bail!("temporary loader/IDL metadata differs");
    }
    verify_program_data(&d.data, number(&archive["deployment"], "deploySlot")?)?;
    let length = u32::from_le_bytes(idl.data[40..44].try_into()?) as usize;
    if length > idl.data.len() - 44 {
        bail!("invalid temporary IDL length");
    }
    let mut raw = Vec::new();
    flate2::read::ZlibDecoder::new(&idl.data[44..44 + length])
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut raw)?;
    if raw.len() > 16 * 1024 * 1024
        || digest(&serde_json::from_slice::<Value>(&raw)?)
            != pin["idlCanonicalSha256"].as_str().unwrap()
    {
        bail!("temporary IDL differs");
    }
    Ok(())
}

pub async fn ingest(pool: &PgPool, rpc: &RpcClient, path: &str) -> Result<()> {
    ingest_bytes(pool, rpc, std::fs::read(path)?).await
}

/// One-off task input. The URL is an owner-issued temporary read of the sealed
/// proof in the existing private backup bucket; it is never printed or stored.
pub async fn ingest_remote(pool: &PgPool, rpc: &RpcClient) -> Result<()> {
    let address = std::env::var("DUSK_RETIREMENT_ARCHIVE_URL")
        .context("DUSK_RETIREMENT_ARCHIVE_URL is required")?;
    let url = reqwest::Url::parse(&address)
        .map_err(|_| anyhow::anyhow!("invalid retirement archive URL"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
        || !url.host_str().is_some_and(|host| {
            host == "s3.ap-southeast-1.amazonaws.com"
                || host == "s3.us-west-2.amazonaws.com"
                || host.ends_with(".s3.ap-southeast-1.amazonaws.com")
                || host.ends_with(".s3.us-west-2.amazonaws.com")
        })
    {
        bail!("retirement archive must use its private AWS S3 HTTPS endpoint");
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("retirement archive download failed"))?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > 128 * 1024 * 1024)
    {
        bail!("retirement archive download failed or exceeds its bound");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("retirement archive download interrupted"))?
    {
        if bytes.len() + chunk.len() > 128 * 1024 * 1024 {
            bail!("retirement archive exceeds bounded input");
        }
        bytes.extend_from_slice(&chunk);
    }
    ingest_bytes(pool, rpc, bytes).await
}

async fn ingest_bytes(pool: &PgPool, rpc: &RpcClient, bytes: Vec<u8>) -> Result<()> {
    if bytes.len() > 128 * 1024 * 1024 {
        bail!("retirement archive exceeds bounded input");
    }
    let archive = checked_archive(serde_json::from_slice(&bytes)?)?;
    let pin = retirement_release();
    let cluster = text(&pin, "cluster")?;
    if rpc.get_genesis_hash().await?.to_string() != text(&pin, "genesisHash")? {
        bail!("wrong retirement RPC network");
    }
    let deploy = number(&archive["deployment"], "deploySlot")?;
    let through = number(&archive, "verifiedThroughSlot")?;
    if rpc.get_slot().await? < through {
        bail!("retirement archive exceeds finalized RPC");
    }
    sqlx::query("INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(cluster).bind(text(&pin,"programId")?).bind(text(&pin,"idlCanonicalSha256")?).bind(text(&pin,"protocolRevision")?).execute(pool).await?;
    let seal = text(&archive, "contentSha256")?;
    // First registration requires the actual reviewed helper to remain active.
    // Subsequent replay requires this identical immutable archive registration.
    let existing: Option<String> = sqlx::query_scalar("SELECT archive_sha256 FROM dusk_ingestion.retirement_archives WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4")
        .bind(cluster).bind(text(&pin,"programId")?).bind(text(&pin,"idlCanonicalSha256")?).bind(text(&pin,"protocolRevision")?).fetch_optional(pool).await?;
    if let Some(saved) = &existing {
        if saved != seal {
            bail!("FINALIZED_INVARIANT: registered retirement archive changed");
        }
    } else {
        attest(pool, rpc, &archive).await?;
    }
    let decoder = PinnedIdlDecoder::legacy_retirement()?;
    let mut observations = archive["observations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let transaction: Value = serde_json::from_str(text(row, "transactionJson")?)?;
            let block: Value = serde_json::from_str(text(row, "blockJson")?)?;
            Ok(json!({"signature":row["signature"],"transaction":transaction,"block":block}))
        })
        .collect::<Result<Vec<Value>>>()?;
    // The archived block order is checked against finalized RPC below.
    observations.sort_by_key(|row| {
        (
            row["transaction"]["slot"].as_u64().unwrap_or(0),
            row["block"]["signatures"]
                .as_array()
                .and_then(|s| s.iter().position(|s| s == &row["signature"]))
                .unwrap_or(usize::MAX),
        )
    });
    let mut events = Vec::new();
    let mut times = Vec::new();
    let mut seen = BTreeSet::new();
    for row in &observations {
        let signature = Signature::from_str(text(row, "signature")?)?;
        if !seen.insert(signature) {
            bail!("duplicate archived transaction");
        }
        let saved: EncodedConfirmedTransactionWithStatusMeta =
            serde_json::from_value(row["transaction"].clone())?;
        if saved.slot <= deploy || saved.slot > through {
            bail!("retirement transaction is outside its observed interval");
        }
        let fetched = rpc
            .get_transaction_with_config(
                &signature,
                RpcTransactionConfig {
                    encoding: Some(UiTransactionEncoding::Base64),
                    commitment: Some(CommitmentConfig::finalized()),
                    max_supported_transaction_version: Some(0),
                },
            )
            .await?;
        observe_rpc(
            pool,
            &archive,
            "transaction",
            &signature.to_string(),
            serde_json::to_value(&fetched)?,
        )
        .await?;
        if serde_json::to_value(&saved)? != serde_json::to_value(&fetched)? {
            bail!("FINALIZED_INVARIANT: finalized retirement transaction changed");
        }
        let tx = fetched
            .transaction
            .transaction
            .decode()
            .context("missing signed retirement transaction")?;
        tx.verify_and_hash_message()
            .context("invalid retirement transaction signatures")?;
        let block = rpc
            .get_block_with_config(
                saved.slot,
                RpcBlockConfig {
                    transaction_details: Some(TransactionDetails::Signatures),
                    rewards: Some(false),
                    commitment: Some(CommitmentConfig::finalized()),
                    max_supported_transaction_version: Some(0),
                    ..Default::default()
                },
            )
            .await?;
        observe_rpc(
            pool,
            &archive,
            "block",
            &saved.slot.to_string(),
            serde_json::to_value(&block)?,
        )
        .await?;
        if serde_json::to_value(&block.signatures)? != row["block"]["signatures"]
            || block.blockhash != text(&row["block"], "blockhash")?
            || block.parent_slot != number(&row["block"], "parentSlot")?
            || block.block_time != saved.block_time
            || block
                .signatures
                .as_ref()
                .context("missing block signatures")?
                .iter()
                .filter(|s| *s == &signature.to_string())
                .count()
                != 1
        {
            bail!("FINALIZED_INVARIANT: retirement block membership differs");
        }
        if fetched
            .transaction
            .meta
            .as_ref()
            .context("missing meta")?
            .err
            .is_some()
        {
            continue;
        }
        let metadata = processors::metadata_from_rpc(&fetched)?;
        let observed = extract::decode_transaction(
            &decoder,
            &signature.to_string(),
            &processors::encode_transaction(&metadata)?,
            &extract::ObservationSource {
                blockhash: &block.blockhash,
                parent_slot: Some(block.parent_slot),
                block_time: block.block_time,
                commitment: Commitment::Finalized,
                source: "verified-legacy-retirement-archive.v1",
            },
        )?;
        let mut keys = metadata.message.static_account_keys().to_vec();
        keys.extend(
            metadata
                .meta
                .loaded_addresses
                .writable
                .iter()
                .chain(&metadata.meta.loaded_addresses.readonly),
        );
        for event in &observed.events {
            let path = &event.observation.key.instruction_path;
            let root = path
                .first()
                .and_then(|index| metadata.message.instructions().get(usize::from(*index)));
            let root_program = root.and_then(|ix| keys.get(usize::from(ix.program_id_index)));
            if path.len() != 2
                || root_program.map(ToString::to_string).as_deref()
                    != Some(text(&pin, "programId")?)
            {
                bail!("retirement receipt is not from a direct committed helper instruction");
            }
        }
        if !observed.orders.is_empty() {
            bail!("unexpected delegated orders in retirement archive");
        }
        let time = Utc
            .timestamp_opt(block.block_time.context("missing actual block time")?, 0)
            .single()
            .context("invalid block time")?;
        times.extend(std::iter::repeat_n(time, observed.events.len()));
        events.extend(observed.events);
    }
    validate_events(&archive, &events)?;
    if existing.is_none() {
        attest(pool, rpc, &archive).await?;
    }
    let expected: Vec<Value> = events
        .iter()
        .map(|e| {
            let r = e.canonical_record();
            json!({"eventKey":r.event_key,"payloadHash":r.payload_hash,"slot":r.slot})
        })
        .collect();
    let mut transaction = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "retirement|{cluster}|{}",
            text(&pin, "protocolRevision")?
        ))
        .execute(&mut transaction)
        .await?;
    sqlx::query("INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(cluster).bind(text(&pin,"programId")?).bind(text(&pin,"idlCanonicalSha256")?).bind(text(&pin,"protocolRevision")?).execute(&mut transaction).await?;
    sqlx::query("INSERT INTO dusk_ingestion.retirement_archives(cluster,program_id,idl_hash,protocol_revision,archive_sha256,market,helper_deploy_slot,verified_through_slot,archive,expected_events) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) ON CONFLICT DO NOTHING")
        .bind(cluster).bind(text(&pin,"programId")?).bind(text(&pin,"idlCanonicalSha256")?).bind(text(&pin,"protocolRevision")?).bind(seal).bind(text(&pin,"market")?)
        .bind(i64::try_from(deploy)?).bind(i64::try_from(through)?).bind(archive.to_string()).bind(serde_json::to_string(&expected)?).execute(&mut transaction).await?;
    let registered: String=sqlx::query_scalar("SELECT archive_sha256 FROM dusk_ingestion.retirement_archives WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4")
        .bind(cluster).bind(text(&pin,"programId")?).bind(text(&pin,"idlCanonicalSha256")?).bind(text(&pin,"protocolRevision")?).fetch_one(&mut transaction).await?;
    if registered != seal {
        bail!("FINALIZED_INVARIANT: retirement registration conflict");
    }
    transaction.commit().await?;
    for (event, time) in events.iter().zip(times) {
        persist::persist_event(pool, event, time, deploy + 1).await?;
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM dusk_ingestion.retirement_payouts WHERE archive_sha256=$1",
    )
    .bind(seal)
    .fetch_one(pool)
    .await?;
    if count != 7 {
        bail!("terminal payout projection is incomplete; rerun this exact archive");
    }
    println!(
        "{}",
        json!({"retirementArchiveSha256":seal,"canonicalEvents":events.len(),"usersPaid":6,"treasuryPaid":true,"liveCursorAdvanced":false})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn terminal_fixture() -> (Value, Vec<DecodedEventEnvelope>) {
        use dusk_indexer_foundation::decoder::{
            TransactionObservationContext, ANCHOR_EVENT_CPI_TAG,
        };
        let pin = retirement_release();
        let idl: Value = serde_json::from_slice(dusk_indexer_foundation::RETIREMENT_IDL).unwrap();
        let decoder = PinnedIdlDecoder::legacy_retirement().unwrap();
        let mut events = Vec::new();
        let mut add = |name: &str, payload: Vec<u8>, slot: u64| {
            let definition = idl["events"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["name"] == name)
                .unwrap();
            let mut raw = ANCHOR_EVENT_CPI_TAG.to_vec();
            raw.extend(
                definition["discriminator"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| b.as_u64().unwrap() as u8),
            );
            raw.extend(payload);
            let context = TransactionObservationContext {
                transaction_signature: format!("local-retirement-fixture-{slot}"),
                slot,
                blockhash: "local-fixture-block".to_owned(),
                parent_slot: Some(slot - 1),
                commitment: Commitment::Finalized,
                observed_at_unix_ms: 1_800_000_000_000,
                source: "local-fixture".to_owned(),
            };
            events.push(
                decoder
                    .decode_event_cpi_instruction(
                        &context,
                        pin["programId"].as_str().unwrap(),
                        vec![1, 0, 2],
                        0,
                        &raw,
                    )
                    .unwrap(),
            );
        };
        let mut payload = 100_u64.to_le_bytes().to_vec();
        payload.extend([1_u8; 64]);
        add("LegacyMarketFrozen", payload, 100);
        let mut payload = vec![171_u8; 32];
        for n in [110_u64, 77, 137] {
            payload.extend(n.to_le_bytes());
        }
        add("LegacyRetirementBegun", payload, 111);
        for (i, owner) in pin["owners"].as_array().unwrap().iter().enumerate() {
            let mut payload = Pubkey::from_str(owner.as_str().unwrap())
                .unwrap()
                .to_bytes()
                .to_vec();
            payload.extend(42_u64.to_le_bytes());
            add("LegacyOwnerCleared", payload, 112 + i as u64);
        }
        for (i, owner) in pin["owners"]
            .as_array()
            .unwrap()
            .iter()
            .chain(std::iter::once(&pin["treasury"]))
            .enumerate()
        {
            let mut payload = Pubkey::from_str(owner.as_str().unwrap())
                .unwrap()
                .to_bytes()
                .to_vec();
            let (base, quote) = if i == 6 {
                (2_u64, 2_u64)
            } else {
                (10 + i as u64, 20 + i as u64)
            };
            payload.extend(base.to_le_bytes());
            payload.extend(quote.to_le_bytes());
            payload.push(u8::from(i == 6));
            add("LegacyRetirementPaid", payload, 118 + i as u64);
        }
        (json!({"onChainManifestSha256":"ab".repeat(32)}), events)
    }
    #[test]
    fn live_attestation_loader_derives_the_pinned_program_data_address() {
        let pin = retirement_release();
        let program = Pubkey::from_str(text(&pin, "programId").unwrap()).unwrap();
        let loader = upgradeable_loader().unwrap();
        let data = Pubkey::find_program_address(&[program.as_ref()], &loader).0;
        assert_eq!(data.to_string(), text(&pin, "programData").unwrap());
    }

    #[test]
    fn actual_helper_wire_receipts_decode_with_distinct_identity_and_full_cpi_path() {
        let (archive, events) = terminal_fixture();
        validate_events(&archive, &events).unwrap();
        assert!(events
            .iter()
            .all(|e| e.observation.key.instruction_path == vec![1, 0, 2]));
        assert!(events
            .iter()
            .all(|e| e.observation.key.identity.protocol_revision
                == "mainnet-retirement-aa196e3423fd"));
        assert_eq!(events[8].decoded_fields.as_ref().unwrap()["base"], "10");
    }
    #[test]
    fn terminal_ledger_rejects_partial_duplicate_reordered_wrong_fork_and_wrong_amount_receipts() {
        let (archive, events) = terminal_fixture();
        let mut missing = events.clone();
        missing.remove(3);
        assert!(validate_events(&archive, &missing).is_err());
        let mut duplicate = events.clone();
        duplicate[3] = duplicate[2].clone();
        assert!(validate_events(&archive, &duplicate).is_err());
        let mut reordered = events.clone();
        reordered.swap(0, 1);
        assert!(validate_events(&archive, &reordered).is_err());
        let mut unfinalized = events.clone();
        unfinalized[8].observation.commitment = Commitment::Confirmed;
        assert!(validate_events(&archive, &unfinalized).is_err());
        let mut amount = events.clone();
        amount[8].decoded_fields.as_mut().unwrap()["base"] = json!("11");
        assert!(validate_events(&archive, &amount).is_err());
        let mut wrong = events.clone();
        wrong[8].decoded_fields.as_mut().unwrap()["owner"] =
            retirement_release()["treasury"].clone();
        assert!(validate_events(&archive, &wrong).is_err());
    }
    #[test]
    fn javascript_sealed_rpc_json_is_verified_without_float_rendering_drift() {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../api/src/tests/fixtures/retirement-json-seal-v2.json"
        )))
        .unwrap();
        assert_eq!(
            digest(&fixture["payload"]),
            fixture["sha256"].as_str().unwrap()
        );
        let rpc: Value = serde_json::from_str(
            fixture["payload"]["observations"][0]["transactionJson"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            rpc["meta"]["preTokenBalances"][0]["uiTokenAmount"]["amount"],
            "2"
        );
    }
    #[test]
    fn exact_helper_decoder_has_its_own_identity_and_rejects_normal_events() {
        let helper = PinnedIdlDecoder::legacy_retirement().unwrap();
        let normal = PinnedIdlDecoder::new("mainnet-beta").unwrap();
        let mut names = helper.event_names(dusk_indexer_foundation::decoder::PinnedProgram::Dusk);
        names.sort();
        assert_eq!(
            names,
            vec![
                "LegacyMarketFrozen",
                "LegacyOwnerCleared",
                "LegacyRetirementBegun",
                "LegacyRetirementPaid"
            ]
        );
        assert!(!normal
            .event_names(dusk_indexer_foundation::decoder::PinnedProgram::Dusk)
            .contains(&"LegacyRetirementPaid"));
    }
    #[test]
    fn local_unsealed_or_wrong_release_archive_is_rejected() {
        for value in [
            json!({}),
            json!({"contentSha256":"00"}),
            json!({"localOnly":true}),
        ] {
            assert!(checked_archive(value).is_err());
        }
    }
    #[test]
    fn partial_receipts_and_noncanonical_amounts_are_not_a_completed_ledger() {
        assert!(validate_events(&json!({}), &[]).is_err());
        for value in [
            json!("01"),
            json!("-1"),
            json!(1),
            json!("18446744073709551616"),
        ] {
            assert!(amount(&value).is_err());
        }
        assert_eq!(amount(&json!("18446744073709551615")).unwrap(), u64::MAX);
    }
}

//! Native LISTEN/NOTIFY → gRPC-Web. Notices trigger reads, never authorize
//! writes.
use {
    crate::grpc_server::stream::DuskChange,
    serde_json::{Value, json},
    sqlx::{PgPool, postgres::PgListener},
    std::{pin::Pin, sync::Arc, time::Duration},
    tokio::sync::{Mutex, Semaphore, watch},
    tokio_stream::Stream,
    tonic::Status,
};

const PIN: &str = include_str!("../../protocol/protocol.lock.json");
const BATCH: Duration = Duration::from_millis(250);
const HEARTBEAT: Duration = Duration::from_secs(2);
type Updates = Pin<Box<dyn Stream<Item = Result<DuskChange, Status>> + Send>>;
#[derive(Clone, Copy, Debug, Default)]
struct Notice {
    ready: bool,
    generation: u64,
    slot: u64,
}

fn notice_slot(payload: &str, pin: &Value) -> Option<u64> {
    if payload.len() > 8192 {
        return None;
    }
    let notice: Value = serde_json::from_str(payload).ok()?;
    let slot = notice["slot"].as_u64()?;
    let programs = pin["programs"].as_array()?;
    let floor = programs
        .iter()
        .filter_map(|p| p["deployment"]["deploySlot"].as_u64())
        .max()?;
    if notice["cluster"] != pin["cluster"]["name"]
        || notice["protocolRevision"] != pin["revision"]
        || slot <= floor
        || slot > 9_007_199_254_740_991
    {
        return None;
    }
    programs
        .iter()
        .any(|p| {
            p["programId"] == notice["programId"]
                && p["idl"]["canonicalSha256"] == notice["idlHash"]
        })
        .then_some(slot)
}

fn valid_envelope(value: &Value, pin: &Value, floor: u64, now: i64) -> bool {
    let d = &value["deployment"];
    let slot = d["sourceSlot"].as_u64().unwrap_or(0);
    let age = d["observedAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| now - t.timestamp_millis());
    if value["success"] != true
        || d["schemaVersion"] != "dusk-deployment.v2"
        || d["commitment"] != "confirmed"
        || d["network"] != pin["cluster"]["name"]
        || d["genesisHash"] != pin["cluster"]["genesisHash"]
        || slot < floor
        || slot == 0
        || slot > 9_007_199_254_740_991
        || !age.is_some_and(|ms| (-1000..15_000).contains(&ms))
        || !d["deploymentIdentitySha256"]
            .as_str()
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return false;
    }
    for (name, prefix) in [("dusk", ""), ("leverage_delegate", "leverageDelegate")] {
        let Some(p) = pin["programs"]
            .as_array()
            .and_then(|ps| ps.iter().find(|p| p["name"] == name))
        else {
            return false;
        };
        let fields = if prefix.is_empty() {
            [
                "programId",
                "programDataAddress",
                "programDataSlot",
                "programUpgradeAuthority",
                "programBinarySha256",
                "idlSha256",
                "idlRawSha256",
            ]
        } else {
            [
                "leverageDelegateProgramId",
                "leverageDelegateProgramDataAddress",
                "leverageDelegateProgramDataSlot",
                "leverageDelegateUpgradeAuthority",
                "leverageDelegateBinarySha256",
                "leverageDelegateIdlSha256",
                "leverageDelegateIdlRawSha256",
            ]
        };
        if d[fields[0]] != p["programId"]
            || d[fields[1]] != p["deployment"]["programData"]
            || d[fields[2]].as_str().and_then(|s| s.parse::<u64>().ok())
                != p["deployment"]["deploySlot"].as_u64()
            || d[fields[3]] != p["deployment"]["upgradeAuthority"]
            || d[fields[4]] != p["binary"]["sha256"]
            || d[fields[5]] != p["idl"]["canonicalSha256"]
            || d[fields[6]] != p["idl"]["sha256"]
        {
            return false;
        }
    }
    true
}

async fn listen(pool: PgPool, sender: watch::Sender<Notice>, pin: Arc<Value>) {
    let mut generation = 0;
    loop {
        generation += 1;
        sender.send_replace(Notice {
            generation,
            ..Default::default()
        });
        let result = async {
            let mut listener = PgListener::connect_with(&pool).await?;
            listener
                .listen_all(["dusk_events_updated", "dusk_accounts_updated"])
                .await?;
            let mut slot = 0;
            sender.send_replace(Notice {
                ready: true,
                generation,
                slot,
            });
            loop {
                // recv() silently reconnects. try_recv() exposes the gap so clients resync.
                let Some(notification) = listener.try_recv().await? else {
                    break;
                };
                if let Some(next) = notice_slot(notification.payload(), &pin) {
                    slot = slot.max(next);
                    sender.send_replace(Notice {
                        ready: true,
                        generation,
                        slot,
                    });
                }
            }
            Ok::<(), sqlx::Error>(())
        }
        .await;
        sender.send_replace(Notice {
            generation,
            ..Default::default()
        });
        if result.is_err() {
            log::warn!("Native database stream unavailable; reconnecting");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[derive(Clone)]
pub struct DuskStream {
    receiver: watch::Receiver<Notice>,
    client: reqwest::Client,
    endpoint: reqwest::Url,
    pin: Arc<Value>,
    capacity: Arc<Semaphore>,
    observation: Arc<Mutex<Option<(tokio::time::Instant, Result<Value, Status>)>>>,
}
impl DuskStream {
    pub fn start(pool: PgPool, api: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let pin: Arc<Value> = Arc::new(serde_json::from_str(PIN)?);
        let mut endpoint = reqwest::Url::parse(&format!(
            "{}/api/dusk/v1/deployment",
            api.trim_end_matches('/')
        ))?;
        if !["http", "https"].contains(&endpoint.scheme())
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            return Err("Invalid native API endpoint".into());
        }
        endpoint.set_query(None);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let (sender, receiver) = watch::channel(Notice::default());
        tokio::spawn(listen(pool, sender, pin.clone()));
        Ok(Self {
            receiver,
            client,
            endpoint,
            pin,
            capacity: Arc::new(Semaphore::new(128)),
            observation: Arc::new(Mutex::new(None)),
        })
    }
    async fn envelope(&self, slot: u64) -> Result<Value, Status> {
        // A burst across many clients shares one observation. Keep the original
        // evidence timestamp; never stamp cached data as newly observed.
        let mut shared = self.observation.lock().await;
        if let Some((at, result)) = shared.as_ref() {
            if at.elapsed() < BATCH
                && result
                    .as_ref()
                    .map(|d| d["sourceSlot"].as_u64().unwrap_or(0) >= slot)
                    .unwrap_or(true)
            {
                return result.clone();
            }
        }
        let result = self.read_envelope(slot).await;
        *shared = Some((tokio::time::Instant::now(), result.clone()));
        result
    }
    async fn read_envelope(&self, slot: u64) -> Result<Value, Status> {
        let fail = || Status::unavailable("Native deployment observation unavailable");
        let mut response = self
            .client
            .get(self.endpoint.clone())
            .query(&[("minimumSourceSlot", slot)])
            .send()
            .await
            .map_err(|_| fail())?
            .error_for_status()
            .map_err(|_| fail())?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| fail())? {
            if bytes.len() + chunk.len() > 16_384 {
                return Err(fail());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
        if !valid_envelope(
            &value,
            &self.pin,
            slot,
            chrono::Utc::now().timestamp_millis(),
        ) {
            return Err(fail());
        }
        Ok(value["deployment"].clone())
    }
    pub fn subscribe(&self) -> Result<Updates, Status> {
        let permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("Native stream capacity reached"))?;
        if !self.receiver.borrow().ready {
            return Err(Status::unavailable("Native listener unavailable"));
        }
        let this = self.clone();
        let mut receiver = self.receiver.clone();
        Ok(Box::pin(async_stream::try_stream! {
            let _permit = permit;
            let generation = receiver.borrow().generation;
            let stream_id = uuid::Uuid::new_v4().to_string();
            let mut sequence = 0u64;
            let mut identity = Value::Null;
            let mut kind = "resync";
            // Fixed server cadence, including quiet markets. Slow observations
            // skip missed ticks instead of building a catch-up burst.
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                if kind == "heartbeat" && receiver.has_changed().unwrap_or(true) { kind = "change"; }
                let notice = *receiver.borrow_and_update();
                if !notice.ready || notice.generation != generation { Err(Status::unavailable("Native listener continuity lost"))?; }
                let slot = if kind == "change" { notice.slot } else { 0 };
                let deployment = this.envelope(slot).await?;
                let current = *receiver.borrow();
                if !current.ready || current.generation != generation { Err(Status::unavailable("Native listener continuity lost"))?; }
                if sequence == 0 { identity = deployment["deploymentIdentitySha256"].clone(); }
                if deployment["deploymentIdentitySha256"] != identity { Err(Status::failed_precondition("Native deployment changed"))?; }
                sequence += 1;
                yield DuskChange { envelope_json: json!({ "success": true, "deployment": deployment,
                    "data": { "schemaVersion": "dusk-read-change.v1", "streamId": stream_id,
                    "sequence": sequence, "kind": kind, "sourceSlot": slot } }).to_string() };
                kind = tokio::select! {
                    result = receiver.changed() => result.map(|_| "change").map_err(|_| Status::unavailable("Native listener closed")),
                    _ = ticks.tick() => Ok("heartbeat"),
                }?;
                // A watch channel coalesces to the highest slot, never buffers unbounded payloads.
                if kind == "change" { tokio::time::sleep(BATCH).await; }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notices_require_the_complete_native_identity() {
        let pin: Value = serde_json::from_str(PIN).unwrap();
        let p = &pin["programs"][0];
        let notice = json!({ "cluster": pin["cluster"]["name"], "protocolRevision": pin["revision"],
            "programId": p["programId"], "idlHash": p["idl"]["canonicalSha256"], "slot": p["deployment"]["deploySlot"].as_u64().unwrap() + 1 });
        assert!(notice_slot(&notice.to_string(), &pin).is_some());
        for key in [
            "cluster",
            "protocolRevision",
            "programId",
            "idlHash",
            "slot",
        ] {
            let mut invalid = notice.clone();
            invalid[key] = json!("wrong");
            assert!(notice_slot(&invalid.to_string(), &pin).is_none());
        }
        assert!(notice_slot("null", &pin).is_none());
        assert!(notice_slot(&"x".repeat(8193), &pin).is_none());
    }
    #[test]
    fn deployment_observations_require_both_programs_and_fresh_evidence() {
        let pin: Value = serde_json::from_str(PIN).unwrap();
        let now = chrono::Utc::now();
        let mut d = json!({ "schemaVersion": "dusk-deployment.v2", "network": pin["cluster"]["name"],
            "genesisHash": pin["cluster"]["genesisHash"], "commitment": "confirmed", "sourceSlot": 500000000,
            "observedAt": now.to_rfc3339(), "deploymentIdentitySha256": "a".repeat(64) });
        for (index, fields) in [
            [
                "programId",
                "programDataAddress",
                "programDataSlot",
                "programUpgradeAuthority",
                "programBinarySha256",
                "idlSha256",
                "idlRawSha256",
            ],
            [
                "leverageDelegateProgramId",
                "leverageDelegateProgramDataAddress",
                "leverageDelegateProgramDataSlot",
                "leverageDelegateUpgradeAuthority",
                "leverageDelegateBinarySha256",
                "leverageDelegateIdlSha256",
                "leverageDelegateIdlRawSha256",
            ],
        ]
        .iter()
        .enumerate()
        {
            let p = &pin["programs"][index];
            for (field, value) in fields.iter().zip([
                p["programId"].clone(),
                p["deployment"]["programData"].clone(),
                json!(p["deployment"]["deploySlot"].as_u64().unwrap().to_string()),
                p["deployment"]["upgradeAuthority"].clone(),
                p["binary"]["sha256"].clone(),
                p["idl"]["canonicalSha256"].clone(),
                p["idl"]["sha256"].clone(),
            ]) {
                d[*field] = value;
            }
        }
        let valid = json!({ "success": true, "deployment": d });
        assert!(valid_envelope(
            &valid,
            &pin,
            500000000,
            now.timestamp_millis()
        ));
        for key in d.as_object().unwrap().keys() {
            let mut invalid = valid.clone();
            invalid["deployment"][key] = Value::Null;
            assert!(
                !valid_envelope(&invalid, &pin, 500000000, now.timestamp_millis()),
                "{key}"
            );
        }
        assert!(!valid_envelope(
            &valid,
            &pin,
            500000001,
            now.timestamp_millis()
        ));
        assert!(!valid_envelope(
            &valid,
            &pin,
            500000000,
            now.timestamp_millis() + 15000
        ));
        assert!(!valid_envelope(
            &valid,
            &pin,
            500000000,
            now.timestamp_millis() - 1001
        ));
    }
}

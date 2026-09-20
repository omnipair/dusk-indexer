//! Bounded full snapshots from the API's shared producer. The browser receives
//! data on one persistent stream instead of refetching after each change hint.
use {
    crate::{
        dusk_stream::valid_envelope,
        grpc_server::stream::{DuskPayload, DuskPayloadsRequest},
    },
    serde_json::{json, Value},
    std::{pin::Pin, sync::Arc, time::Duration},
    tokio::sync::Semaphore,
    tokio_stream::Stream,
    tonic::Status,
};

pub type Updates = Pin<Box<dyn Stream<Item = Result<DuskPayload, Status>> + Send>>;
const MAX_FRAME: usize = 2 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(35);

fn selection(r: &DuskPayloadsRequest) -> Result<Value, Status> {
    let invalid = || Status::invalid_argument("Invalid payload selection");
    if r.kind == "markets" && r.market.is_empty() && r.side.is_empty() && r.resolution_seconds == 0
    {
        return Ok(json!({"kind":"markets"}));
    }
    let bytes = bs58::decode(&r.market).into_vec().map_err(|_| invalid())?;
    if bytes.len() != 32 || bs58::encode(bytes).into_string() != r.market {
        return Err(invalid());
    }
    match r.kind.as_str() {
        "trades" if r.side.is_empty() && r.resolution_seconds == 0 => {
            Ok(json!({"kind":"trades","market":r.market}))
        }
        "candles"
            if ["base", "quote"].contains(&r.side.as_str())
                && [60, 300, 900, 3600, 14400, 86400].contains(&r.resolution_seconds) =>
        {
            Ok(
                json!({"kind":"candles","market":r.market,"side":r.side,"resolutionSeconds":r.resolution_seconds}),
            )
        }
        _ => Err(invalid()),
    }
}

fn valid_payload(v: &Value, selected: &Value, pin: &Value, now: i64) -> bool {
    let d = &v["data"];
    let Some(observed) = d["observedAt"].as_i64() else {
        return false;
    };
    let Some(expires) = d["expiresAt"].as_i64() else {
        return false;
    };
    let Some(slot) = d["sourceSlot"].as_u64() else {
        return false;
    };
    let lifetime = if selected["kind"] == "markets" {
        15_000
    } else {
        60_000
    };
    let floor = pin["programs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["deployment"]["deploySlot"].as_u64())
        .max()
        .unwrap_or(u64::MAX);
    slot > floor
        && observed > 0
        && expires <= 9_007_199_254_740_991
        && valid_envelope(v, pin, slot, now)
        && d["schemaVersion"] == "dusk-payload.v1"
        && d["selection"] == *selected
        && observed <= now + 1000
        && expires > now
        && expires > observed
        && expires - observed == lifetime
        && !d["payload"].is_null()
        && d["revision"]
            .as_str()
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        && d["streamId"]
            .as_str()
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        && d["sequence"]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
}

pub fn subscribe(
    mut endpoint: reqwest::Url,
    pin: Arc<Value>,
    capacity: Arc<Semaphore>,
    request: DuskPayloadsRequest,
) -> Result<Updates, Status> {
    let selected = selection(&request)?;
    let permit = capacity
        .try_acquire_owned()
        .map_err(|_| Status::resource_exhausted("Native stream capacity reached"))?;
    endpoint.set_path("/api/dusk/v1/payloads");
    endpoint.set_query(None);
    for (key, value) in selected.as_object().unwrap() {
        endpoint.query_pairs_mut().append_pair(
            key,
            &value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string()),
        );
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Status::internal("Payload transport unavailable"))?;
    Ok(Box::pin(async_stream::try_stream! {
        let _permit = permit;
        let fail = || Status::unavailable("Native payload stream unavailable");
        let mut response = tokio::time::timeout(DEADLINE, client.get(endpoint).send()).await
            .map_err(|_| fail())?.map_err(|_| fail())?.error_for_status().map_err(|_| fail())?;
        if response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap_or("").trim()) != Some("text/event-stream") { Err(fail())?; }
        let mut buffer = Vec::<u8>::new();
        let mut identity = Value::Null;
        let mut stream_id = Value::Null;
        let mut sequence = 0u64;
        loop {
            let chunk = tokio::time::timeout(DEADLINE, response.chunk()).await.map_err(|_| fail())?.map_err(|_| fail())?;
            let Some(chunk) = chunk else { Err(fail())?; unreachable!() };
            if buffer.len() + chunk.len() > MAX_FRAME { Err(Status::resource_exhausted("Payload frame too large"))?; }
            buffer.extend_from_slice(&chunk);
            while let Some(end) = buffer.windows(2).position(|w| w == b"\n\n") {
                let frame: Vec<_> = buffer.drain(..end + 2).collect();
                let text = std::str::from_utf8(&frame).map_err(|_| fail())?;
                if text.starts_with(':') { continue; }
                let Some(body) = text.strip_prefix("event: dusk-payload\ndata: ").and_then(|v| v.strip_suffix("\n\n")) else { Err(fail())?; unreachable!() };
                let value: Value = serde_json::from_str(body).map_err(|_| fail())?;
                if !valid_payload(&value, &selected, &pin, chrono::Utc::now().timestamp_millis()) { Err(fail())?; }
                if sequence == 0 { identity = value["deployment"]["deploymentIdentitySha256"].clone(); stream_id = value["data"]["streamId"].clone(); }
                if value["deployment"]["deploymentIdentitySha256"] != identity || value["data"]["streamId"] != stream_id
                    || value["data"]["sequence"].as_u64() != Some(sequence + 1) { Err(Status::failed_precondition("Payload stream continuity lost"))?; }
                sequence += 1;
                yield DuskPayload { envelope_json: body.to_owned() };
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_require_matching_selection_freshness_and_identity() {
        let pin: Value =
            serde_json::from_str(include_str!("../../protocol/protocol.lock.json")).unwrap();
        let frame: Value = serde_json::from_str(include_str!(
            "../../api/src/tests/fixtures/payload-envelope-devnet-20260920.json"
        ))
        .unwrap();
        let now = chrono::DateTime::parse_from_rfc3339(
            frame["deployment"]["observedAt"].as_str().unwrap(),
        )
        .unwrap()
        .timestamp_millis();
        let selected = json!({"kind":"markets"});
        assert!(valid_payload(&frame, &selected, &pin, now));
        for field in [
            "selection",
            "observedAt",
            "expiresAt",
            "sourceSlot",
            "sequence",
            "streamId",
            "revision",
            "payload",
        ] {
            let mut broken = frame.clone();
            broken["data"][field] = Value::Null;
            assert!(!valid_payload(&broken, &selected, &pin, now), "{field}");
        }
        let mut broken = frame.clone();
        broken["data"]["sourceSlot"] = json!(0);
        assert!(!valid_payload(&broken, &selected, &pin, now));
        let mut broken = frame.clone();
        broken["deployment"]["programId"] = Value::Null;
        assert!(!valid_payload(&broken, &selected, &pin, now));
        assert!(!valid_payload(
            &frame,
            &selected,
            &pin,
            frame["data"]["expiresAt"].as_i64().unwrap()
        ));
    }
    #[tokio::test]
    async fn bridge_forwards_fragmented_sse_and_rejects_a_sequence_gap() {
        use {
            tokio::io::{AsyncReadExt, AsyncWriteExt},
            tokio_stream::StreamExt,
        };
        let pin: Value =
            serde_json::from_str(include_str!("../../protocol/protocol.lock.json")).unwrap();
        let mut frame: Value = serde_json::from_str(include_str!(
            "../../api/src/tests/fixtures/payload-envelope-devnet-20260920.json"
        ))
        .unwrap();
        let now = chrono::Utc::now();
        frame["deployment"]["observedAt"] = json!(now.to_rfc3339());
        frame["data"]["observedAt"] = json!(now.timestamp_millis());
        frame["data"]["expiresAt"] = json!(now.timestamp_millis() + 15000);
        let first = format!("event: dusk-payload\ndata: {}\n\n", frame);
        frame["data"]["sequence"] = json!(3);
        let body = format!(
            ": heartbeat\n\n{}event: dusk-payload\ndata: {}\n\n",
            first, frame
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let size = socket.read(&mut request).await.unwrap();
            assert!(std::str::from_utf8(&request[..size])
                .unwrap()
                .contains("/api/dusk/v1/payloads?kind=markets"));
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes()).await.unwrap();
            for part in body.as_bytes().chunks(37) {
                socket.write_all(part).await.unwrap();
            }
        });
        let capacity = Arc::new(Semaphore::new(1));
        let mut stream = subscribe(
            reqwest::Url::parse(&format!("http://{address}/api/dusk/v1/deployment")).unwrap(),
            Arc::new(pin),
            capacity.clone(),
            DuskPayloadsRequest {
                kind: "markets".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let received = stream.next().await.unwrap().unwrap();
        let decoded: Value = serde_json::from_str(&received.envelope_json).unwrap();
        assert_eq!(decoded["data"]["sequence"], 1);
        assert_eq!(
            stream.next().await.unwrap().unwrap_err().code(),
            tonic::Code::FailedPrecondition
        );
        drop(stream);
        assert_eq!(capacity.available_permits(), 1);
        server.await.unwrap();
    }
    #[test]
    fn subscription_scope_is_bounded_and_canonical() {
        let mut request = DuskPayloadsRequest {
            kind: "markets".into(),
            ..Default::default()
        };
        assert_eq!(selection(&request).unwrap(), json!({"kind":"markets"}));
        request.market = "11111111111111111111111111111111".into();
        assert!(selection(&request).is_err());
        request.kind = "trades".into();
        assert!(selection(&request).is_ok());
        request.kind = "candles".into();
        request.side = "base".into();
        request.resolution_seconds = 900;
        assert!(selection(&request).is_ok());
        request.resolution_seconds = 1;
        assert!(selection(&request).is_err());
        request.resolution_seconds = 900;
        request.market.push('1');
        assert!(selection(&request).is_err());
    }
}

//! Exact preview origins registered by authenticated Vercel deployment events.
use std::{
    collections::HashSet,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
const PROJECT: &str = "prj_ztwzUn81e0xHqLa2NjoHbnqXy0EF";
const TEAM: &str = "team_mUKFDc1HjGHQuYhtdIuDIh0x";
const SCHEMA: &str = "dusk-owned-preview-origins.v1";
#[derive(Default)]
struct Cache {
    origins: HashSet<String>,
    loaded: Option<Instant>,
}
#[derive(Clone)]
pub struct PreviewOrigins {
    url: Option<reqwest::Url>,
    client: reqwest::Client,
    cache: Arc<RwLock<Cache>>,
}
fn valid_origin(origin: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(origin) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let Some(label) = host.strip_suffix(".vercel.app") else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == "/"
        && url.origin().ascii_serialization() == origin
        && !label.is_empty()
        && label.len() <= 63
        && label
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn parse_registry(body: &[u8]) -> Result<HashSet<String>, ()> {
    if body.len() > 1_000_000 {
        return Err(());
    }
    let v: serde_json::Value = serde_json::from_slice(body).map_err(|_| ())?;
    if v["schemaVersion"] != SCHEMA || v["projectId"] != PROJECT || v["teamId"] != TEAM {
        return Err(());
    }
    let origins = v["origins"].as_array().ok_or(())?;
    if origins.len() > 10_000 {
        return Err(());
    }
    origins
        .iter()
        .map(|v| {
            v.as_str()
                .filter(|s| valid_origin(s))
                .map(str::to_owned)
                .ok_or(())
        })
        .collect()
}
impl PreviewOrigins {
    pub fn new(api: Option<String>) -> Self {
        let url = api
            .and_then(|s| reqwest::Url::parse(&s).ok())
            .filter(|u| {
                ["http", "https"].contains(&u.scheme())
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.query().is_none()
                    && u.fragment().is_none()
            })
            .map(|mut u| {
                u.set_path("/internal/browser-origins");
                u
            });
        let registry = Self {
            url,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("preview HTTP client"),
            cache: Arc::default(),
        };
        if registry.url.is_some() {
            let reader = registry.clone();
            tokio::spawn(async move {
                loop {
                    reader.refresh().await;
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            });
        }
        registry
    }
    async fn fetch(&self) -> Result<HashSet<String>, ()> {
        let mut response = self
            .client
            .get(self.url.clone().ok_or(())?)
            .send()
            .await
            .map_err(|_| ())?;
        if !response.status().is_success()
            || response.content_length().is_some_and(|n| n > 1_000_000)
        {
            return Err(());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            if body.len() + chunk.len() > 1_000_000 {
                return Err(());
            }
            body.extend_from_slice(&chunk);
        }
        parse_registry(&body)
    }
    async fn refresh(&self) {
        let result = self.fetch().await;
        let Ok(mut cache) = self.cache.write() else {
            return;
        };
        match result {
            Ok(origins) => {
                cache.origins = origins;
                cache.loaded = Some(Instant::now())
            }
            Err(()) => {
                cache.origins.clear();
                cache.loaded = None;
            }
        }
    }
    pub fn allows(&self, origin: &str) -> bool {
        if self.url.is_none() || !valid_origin(origin) {
            return false;
        }
        let Ok(cache) = self.cache.read() else {
            return false;
        };
        cache
            .loaded
            .is_some_and(|t| t.elapsed() < Duration::from_secs(15))
            && cache.origins.contains(origin)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn registry(origins: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"schemaVersion":SCHEMA,"projectId":PROJECT,"teamId":TEAM,"origins":origins})).unwrap()
    }
    #[test]
    fn exact_registered_hosts_only() {
        let body = registry(serde_json::json!(["https://dusk-preview.vercel.app"]));
        let parsed = parse_registry(&body).unwrap();
        assert!(parsed.contains("https://dusk-preview.vercel.app"));
        for origin in [
            "https://attacker.example",
            "https://preview.vercel.app.evil",
            "http://preview.vercel.app",
            "https://preview.vercel.app:444",
            "https://preview.vercel.app/path",
            "https://user@preview.vercel.app",
            "null",
            "https://*.vercel.app",
        ] {
            assert!(!valid_origin(origin), "{origin}");
            assert!(parse_registry(&registry(serde_json::json!([origin]))).is_err());
        }
    }
    #[test]
    fn registry_owner_schema_shape_and_size_are_required() {
        for field in ["schemaVersion", "projectId", "teamId", "origins"] {
            let mut v: serde_json::Value =
                serde_json::from_slice(&registry(serde_json::json!([]))).unwrap();
            v[field] = serde_json::Value::Null;
            assert!(parse_registry(&serde_json::to_vec(&v).unwrap()).is_err());
        }
        assert!(parse_registry(&vec![b' '; 1_000_001]).is_err());
    }
    #[tokio::test]
    async fn authenticated_registry_cache_expires_and_clears_on_transport_failure() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = reqwest::Url::parse(&format!(
            "http://{}/internal/browser-origins",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let body = registry(serde_json::json!(["https://owned-preview.vercel.app"]));
        let handle = std::thread::spawn(move || {
            for (status, bytes) in [("200 OK", body), ("503 Unavailable", Vec::new())] {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0; 2048];
                socket.read(&mut request).unwrap();
                write!(
                    socket,
                    "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                    bytes.len()
                )
                .unwrap();
                socket.write_all(&bytes).unwrap();
            }
        });
        // No background scheduler in this deterministic transport test.
        let r = PreviewOrigins {
            url: Some(url),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(1))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            cache: Arc::default(),
        };
        r.refresh().await;
        assert!(r.allows("https://owned-preview.vercel.app"));
        assert!(!r.allows("https://foreign.vercel.app"));
        r.cache.write().unwrap().loaded = Some(Instant::now() - Duration::from_secs(16));
        assert!(!r.allows("https://owned-preview.vercel.app"));
        r.refresh().await;
        assert!(!r.allows("https://owned-preview.vercel.app"));
        handle.join().unwrap();
    }
    #[tokio::test]
    async fn unavailable_or_unconfigured_registry_fails_closed() {
        assert!(!PreviewOrigins::new(None).allows("https://preview.vercel.app"));
        assert!(
            !PreviewOrigins::new(Some("http://127.0.0.1:1".into()))
                .allows("https://preview.vercel.app")
        );
    }
}

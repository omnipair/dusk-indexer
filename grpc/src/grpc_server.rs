use http;
use std::time::Duration;
use tokio::signal;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tonic::{Request, Response, Status};
use tonic_health::server::health_reporter;
use tower_http::cors::{AllowOrigin, CorsLayer};

pub mod stream {
    tonic::include_proto!("omnipair.stream");
}

pub const FILE_DESCRIPTOR_SET: &[u8] = tonic::include_file_descriptor_set!("stream_descriptor");

use stream::{
    stream_service_server::{StreamService, StreamServiceServer},
    SwapsRequest, SwapsUpdate,
};
use tonic_web::GrpcWebLayer;

/// Does `origin` match one of the configured CORS patterns?
///
/// A preview deployment gets a fresh hostname on every build, so an exact list
/// can never cover one. A `*` stands for any run of characters **within the
/// single hostname label it appears in**: `https://*-omnipair.vercel.app`
/// admits `https://dusk-webapp-abc123-omnipair.vercel.app` but not a
/// subdomain below it, and not a host that merely ends with the same text.
/// Patterns without a `*` compare exactly.
fn origin_allowed(patterns: &[String], origin: &str) -> bool {
    patterns.iter().any(|pattern| match pattern.split_once('*') {
        None => pattern == origin,
        Some((prefix, suffix)) => {
            origin.len() >= prefix.len() + suffix.len()
                && origin.starts_with(prefix)
                && origin.ends_with(suffix)
                && !origin[prefix.len()..origin.len() - suffix.len()].contains('.')
        }
    })
}

#[cfg(test)]
mod tests {
    use super::origin_allowed;

    fn patterns() -> Vec<String> {
        vec![
            "http://localhost:3009".into(),
            "https://dusk-webapp.vercel.app".into(),
            "https://*-omnipair.vercel.app".into(),
        ]
    }

    #[test]
    fn exact_patterns_match_only_themselves() {
        assert!(origin_allowed(&patterns(), "http://localhost:3009"));
        assert!(origin_allowed(&patterns(), "https://dusk-webapp.vercel.app"));
        assert!(!origin_allowed(&patterns(), "http://localhost:3000"));
    }

    #[test]
    fn a_wildcard_admits_every_preview_hostname() {
        assert!(origin_allowed(
            &patterns(),
            "https://dusk-webapp-fyvc70od6-omnipair.vercel.app"
        ));
        assert!(origin_allowed(
            &patterns(),
            "https://omnipair-webapp-git-surfpool-omnipair.vercel.app"
        ));
    }

    /// The reason the wildcard cannot cross a dot: without this, anyone able to
    /// publish at a hostname ending in the pattern's suffix reads the stream.
    #[test]
    fn a_wildcard_does_not_cross_a_dot() {
        assert!(!origin_allowed(
            &patterns(),
            "https://evil.dusk-webapp-x-omnipair.vercel.app"
        ));
        assert!(!origin_allowed(
            &patterns(),
            "https://attacker-omnipair.vercel.app.evil.com"
        ));
        assert!(!origin_allowed(
            &patterns(),
            "https://dusk-webapp.vercel.app.evil.com"
        ));
    }

    /// A `*` stands for at least nothing, but the separator around it is still
    /// required — `omnipair.vercel.app` is missing the `-`.
    #[test]
    fn the_literal_parts_of_a_pattern_are_still_required() {
        assert!(!origin_allowed(&patterns(), "https://omnipair.vercel.app"));
    }
}

pub struct SwapStreamServer {
    broadcast_tx: broadcast::Sender<SwapsUpdate>,
}

impl SwapStreamServer {
    pub fn new(broadcast_tx: broadcast::Sender<SwapsUpdate>) -> Self {
        Self { broadcast_tx }
    }

    pub fn into_service(self) -> StreamServiceServer<Self> {
        StreamServiceServer::new(self)
    }
}

#[tonic::async_trait]
impl StreamService for SwapStreamServer {
    type StreamSwapsUpdatesStream = std::pin::Pin<
        Box<dyn tokio_stream::Stream<Item = Result<SwapsUpdate, Status>> + Send + 'static>,
    >;

    async fn stream_swaps_updates(
        &self,
        request: Request<SwapsRequest>,
    ) -> Result<Response<Self::StreamSwapsUpdatesStream>, Status> {
        let peer_addr = request.remote_addr();
        log::info!("New gRPC stream connection from {:?}", peer_addr);

        let rx = self.broadcast_tx.subscribe();
        let mut lag_count = 0u64;
        const MAX_LAG_THRESHOLD: u64 = 1000;

        let stream = BroadcastStream::new(rx).filter_map(move |result| match result {
            Ok(swap_update) => {
                if lag_count > 0 {
                    log::warn!(
                        "Client {:?} recovered from {} lag events",
                        peer_addr,
                        lag_count
                    );
                    lag_count = 0;
                }
                Some(Ok(swap_update))
            }
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(skipped)) => {
                lag_count += skipped;
                log::error!(
                    "Client {:?} lagging: skipped {} messages (total lag: {})",
                    peer_addr,
                    skipped,
                    lag_count
                );

                if lag_count > MAX_LAG_THRESHOLD {
                    log::error!(
                        "Client {:?} exceeded lag threshold, disconnecting",
                        peer_addr
                    );
                    Some(Err(Status::resource_exhausted(
                        "Client too slow, connection terminated",
                    )))
                } else {
                    None
                }
            }
        });

        Ok(Response::new(Box::pin(stream)))
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            log::info!("Received SIGINT (Ctrl+C), initiating graceful shutdown...");
        },
        _ = terminate => {
            log::info!("Received SIGTERM, initiating graceful shutdown...");
        },
    }
}

pub async fn start_grpc_server(
    broadcast_tx: broadcast::Sender<SwapsUpdate>,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let addr = format!("0.0.0.0:{}", port).parse()?;
    let server = SwapStreamServer::new(broadcast_tx);

    let is_production = std::env::var("NODE_ENV")
        .map(|env| env.to_lowercase() == "production")
        .unwrap_or(false);

    // Create health reporter for health checks
    let (mut health_reporter, health_service) = health_reporter();

    // Set the overall server health to serving
    health_reporter
        .set_serving::<StreamServiceServer<SwapStreamServer>>()
        .await;

    log::info!("Starting gRPC server on {}", addr);
    log::info!("Health check endpoint available at /grpc.health.v1.Health/Check");

    // Enable reflection only in development (for grpcurl and debugging tools)
    if !is_production {
        log::info!("gRPC reflection enabled for development/debugging");
    }

    let allowed_origin = if is_production {
        log::info!("Running in production mode with restricted CORS");
        let allowed_origins = std::env::var("ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "https://omnipair.fi,https://legacy.omnipair.fi".to_string());

        let patterns: Vec<String> = allowed_origins
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        log::info!("CORS allows: {}", patterns.join(", "));

        AllowOrigin::predicate(move |origin, _| {
            origin
                .to_str()
                .is_ok_and(|origin| origin_allowed(&patterns, origin))
        })
    } else {
        log::info!("Running in development mode with permissive CORS");
        AllowOrigin::any()
    };

    let cors = CorsLayer::new()
        .allow_origin(allowed_origin)
        .allow_methods([http::Method::POST, http::Method::OPTIONS])
        .allow_headers([
            http::header::CONTENT_TYPE,
            http::header::HeaderName::from_static("x-grpc-web"),
            http::header::HeaderName::from_static("grpc-timeout"),
        ])
        .expose_headers([
            http::header::HeaderName::from_static("grpc-status"),
            http::header::HeaderName::from_static("grpc-message"),
        ]);

    log::info!("gRPC server listening on {}", addr);

    // Add reflection service only in development
    if !is_production {
        let reflection_service = tonic_reflection::server::Builder::configure()
            .register_encoded_file_descriptor_set(FILE_DESCRIPTOR_SET)
            .register_encoded_file_descriptor_set(tonic_health::pb::FILE_DESCRIPTOR_SET)
            .build_v1()?;

        tonic::transport::Server::builder()
            .accept_http1(true)
            .concurrency_limit_per_connection(256)
            .tcp_keepalive(Some(Duration::from_secs(60)))
            .tcp_nodelay(true)
            .layer(cors)
            .layer(GrpcWebLayer::new())
            .add_service(reflection_service)
            .add_service(health_service)
            .add_service(server.into_service())
            .serve_with_shutdown(addr, shutdown_signal())
            .await?;
    } else {
        tonic::transport::Server::builder()
            .accept_http1(true)
            .concurrency_limit_per_connection(256)
            .tcp_keepalive(Some(Duration::from_secs(60)))
            .tcp_nodelay(true)
            .layer(cors)
            .layer(GrpcWebLayer::new())
            .add_service(health_service)
            .add_service(server.into_service())
            .serve_with_shutdown(addr, shutdown_signal())
            .await?;
    }

    log::info!("gRPC server shut down gracefully");

    Ok(())
}

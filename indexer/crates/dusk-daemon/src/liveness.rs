//! Whether the stream is delivering, for the cursor heartbeat.
//!
//! The Helius datasource watches the Clock sysvar on the same WebSocket as the
//! transaction subscription and reconnects after 5 s without an update. Every
//! Clock update it verifies records one histogram sample; this metrics sink
//! keeps the time of the latest.

use {
    async_trait::async_trait,
    carbon_core::{error::CarbonResult, metrics::Metrics},
    std::{
        sync::Mutex,
        time::{Duration, Instant},
    },
};

const CLOCK_METRIC: &str = "helius_atlas_ws_clock_process_time_nanoseconds";

#[derive(Default)]
pub struct StreamLiveness {
    last_clock: Mutex<Option<Instant>>,
}

impl StreamLiveness {
    pub fn live_within(&self, window: Duration) -> bool {
        self.last_clock
            .lock()
            .map(|last| last.is_some_and(|at| at.elapsed() <= window))
            .unwrap_or(false)
    }
}

#[async_trait]
impl Metrics for StreamLiveness {
    async fn initialize(&self) -> CarbonResult<()> {
        Ok(())
    }

    async fn flush(&self) -> CarbonResult<()> {
        Ok(())
    }

    async fn shutdown(&self) -> CarbonResult<()> {
        Ok(())
    }

    async fn update_gauge(&self, _name: &str, _value: f64) -> CarbonResult<()> {
        Ok(())
    }

    async fn increment_counter(&self, _name: &str, _value: u64) -> CarbonResult<()> {
        Ok(())
    }

    async fn record_histogram(&self, name: &str, _value: f64) -> CarbonResult<()> {
        if name == CLOCK_METRIC {
            if let Ok(mut last) = self.last_clock.lock() {
                *last = Some(Instant::now());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_a_verified_clock_update_marks_the_stream_live() {
        let liveness = StreamLiveness::default();
        let window = Duration::from_secs(10);
        assert!(!liveness.live_within(window));
        liveness
            .record_histogram("helius_atlas_ws_transaction_process_time_nanoseconds", 1.0)
            .await
            .unwrap();
        assert!(!liveness.live_within(window));
        liveness.record_histogram(CLOCK_METRIC, 1.0).await.unwrap();
        assert!(liveness.live_within(window));
    }
}

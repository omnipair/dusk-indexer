//! Discord alerts for a stalled stream.
//!
//! The cursor heartbeat already samples stream liveness every few seconds.
//! `StallAlarm` turns those samples into at most one message per change of
//! state, plus an hourly reminder while a stall lasts, so alerting adds no
//! reads of the database or the API. Without `DUSK_ALERT_DISCORD_WEBHOOK` the
//! daemon sends nothing.

use std::time::{Duration, Instant};

/// A stall shorter than this is a reconnect, not an outage. The API already
/// refuses reads 15 s into one, so a minute means users are affected.
const DEFAULT_STALL: Duration = Duration::from_secs(60);
const DEFAULT_REMIND: Duration = Duration::from_secs(3600);
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// What a liveness sample changed.
#[derive(Debug, PartialEq, Eq)]
pub enum Notice {
    Stalled { for_secs: u64 },
    StillStalled { for_secs: u64 },
    Recovered { after_secs: u64 },
}

pub struct StallAlarm {
    after: Duration,
    remind: Duration,
    stalled_since: Option<Instant>,
    last_sent: Option<Instant>,
}

impl StallAlarm {
    pub fn new(after: Duration, remind: Duration) -> Self {
        Self {
            after,
            remind,
            stalled_since: None,
            last_sent: None,
        }
    }

    /// `DUSK_ALERT_STALL_SECONDS` and `DUSK_ALERT_REMIND_SECONDS`, or a minute
    /// and an hour.
    pub fn from_env() -> Self {
        let seconds = |name: &str, default: Duration| {
            std::env::var(name)
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|seconds| *seconds > 0)
                .map(Duration::from_secs)
                .unwrap_or(default)
        };
        Self::new(
            seconds("DUSK_ALERT_STALL_SECONDS", DEFAULT_STALL),
            seconds("DUSK_ALERT_REMIND_SECONDS", DEFAULT_REMIND),
        )
    }

    /// `live` is whether a verified Clock update arrived within the liveness
    /// window at `now`. Recovery is announced only for a stall that was.
    pub fn observe(&mut self, live: bool, now: Instant) -> Option<Notice> {
        if live {
            let since = self.stalled_since.take()?;
            return self.last_sent.take().map(|_| Notice::Recovered {
                after_secs: now.duration_since(since).as_secs(),
            });
        }
        let since = *self.stalled_since.get_or_insert(now);
        let stalled = now.duration_since(since);
        if stalled < self.after {
            return None;
        }
        let for_secs = stalled.as_secs();
        match self.last_sent {
            None => {
                self.last_sent = Some(now);
                Some(Notice::Stalled { for_secs })
            }
            Some(sent) if now.duration_since(sent) >= self.remind => {
                self.last_sent = Some(now);
                Some(Notice::StillStalled { for_secs })
            }
            Some(_) => None,
        }
    }
}

/// The Discord message for a notice on `cluster`.
pub fn message(notice: &Notice, cluster: &str) -> String {
    match notice {
        Notice::Stalled { for_secs } => format!(
            "🔴 **Dusk {cluster} indexer stalled.** No verified stream update for {}. \
             The API refuses reads while the stream is stale, so the app shows markets as \
             unavailable. Logs: `railway logs -s dusk-indexer`.",
            duration(*for_secs)
        ),
        Notice::StillStalled { for_secs } => format!(
            "🔴 Dusk {cluster} indexer still stalled, {} without a verified stream update.",
            duration(*for_secs)
        ),
        Notice::Recovered { after_secs } => format!(
            "🟢 **Dusk {cluster} indexer recovered** after {}. Catch-up replays the \
             transactions missed since the cursor's last slot.",
            duration(*after_secs)
        ),
    }
}

fn duration(seconds: u64) -> String {
    match seconds {
        0..=89 => format!("{seconds} s"),
        90..=5399 => format!("{} min", (seconds + 30) / 60),
        _ => {
            let minutes = (seconds + 30) / 60;
            format!("{} h {} min", minutes / 60, minutes % 60)
        }
    }
}

/// Posts notices to a Discord webhook without holding up the heartbeat.
pub struct Discord {
    client: reqwest::Client,
    url: String,
}

impl Discord {
    /// The webhook in `DUSK_ALERT_DISCORD_WEBHOOK`, if one is set.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let Some(url) = std::env::var("DUSK_ALERT_DISCORD_WEBHOOK")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        else {
            return Ok(None);
        };
        // The URL is a credential: it is checked here and never logged.
        if !url.starts_with("https://") {
            anyhow::bail!("DUSK_ALERT_DISCORD_WEBHOOK must be an https URL");
        }
        let client = reqwest::Client::builder().timeout(SEND_TIMEOUT).build()?;
        Ok(Some(Self { client, url }))
    }

    pub fn send(&self, content: String) {
        let request = self.client.post(&self.url).json(&serde_json::json!({
            "content": content,
            "allowed_mentions": { "parse": [] },
        }));
        tokio::spawn(async move {
            match request.send().await {
                Ok(response) if response.status().is_success() => {}
                Ok(response) => {
                    log::warn!("Discord alert refused: HTTP {}", response.status())
                }
                Err(error) => log::warn!("Discord alert failed: {}", error.without_url()),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alarm() -> (StallAlarm, Instant) {
        (
            StallAlarm::new(Duration::from_secs(60), Duration::from_secs(3600)),
            Instant::now(),
        )
    }

    #[test]
    fn a_short_reconnect_sends_nothing() {
        let (mut alarm, start) = alarm();
        assert_eq!(alarm.observe(true, start), None);
        assert_eq!(alarm.observe(false, start), None);
        assert_eq!(alarm.observe(false, start + Duration::from_secs(55)), None);
        assert_eq!(alarm.observe(true, start + Duration::from_secs(56)), None);
    }

    #[test]
    fn a_stall_alerts_once_reminds_hourly_and_announces_recovery() {
        let (mut alarm, start) = alarm();
        let at = |seconds| start + Duration::from_secs(seconds);
        assert_eq!(alarm.observe(false, at(0)), None);
        assert_eq!(
            alarm.observe(false, at(60)),
            Some(Notice::Stalled { for_secs: 60 })
        );
        assert_eq!(alarm.observe(false, at(65)), None);
        assert_eq!(alarm.observe(false, at(3655)), None);
        assert_eq!(
            alarm.observe(false, at(3660)),
            Some(Notice::StillStalled { for_secs: 3660 })
        );
        assert_eq!(
            alarm.observe(true, at(3700)),
            Some(Notice::Recovered { after_secs: 3700 })
        );
        assert_eq!(alarm.observe(true, at(3705)), None);
        // A later stall starts its own count.
        assert_eq!(alarm.observe(false, at(4000)), None);
        assert_eq!(
            alarm.observe(false, at(4060)),
            Some(Notice::Stalled { for_secs: 60 })
        );
    }

    #[test]
    fn messages_name_the_cluster_and_a_readable_duration() {
        assert!(
            message(&Notice::Stalled { for_secs: 60 }, "devnet").starts_with(
                "🔴 **Dusk devnet indexer stalled.** No verified stream update for 60 s."
            )
        );
        assert!(message(&Notice::Recovered { after_secs: 36_120 }, "devnet")
            .contains("recovered** after 10 h 2 min."));
        assert_eq!(duration(89), "89 s");
        assert_eq!(duration(90), "2 min");
        assert_eq!(duration(5399), "90 min");
        assert_eq!(duration(5400), "1 h 30 min");
    }
}

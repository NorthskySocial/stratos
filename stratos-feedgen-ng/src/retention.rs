use std::{fmt, sync::Arc, time::Duration};

use time::OffsetDateTime;
use tokio::{sync::watch, task::JoinHandle};

use crate::{
    config::ProjectionRetention,
    lifecycle::ControlLifecycle,
    store::{ProjectionCompaction, StoreError},
};

const COMPACTION_INTERVAL: Duration = Duration::from_secs(60);
const COMPACTION_BATCH: u16 = 128;
const MAX_BACKGROUND_PASSES: u8 = 4;
const MAX_STARTUP_PASSES: u8 = 64;

#[derive(Debug)]
pub enum RetentionError {
    Store(StoreError),
    NotCaughtUp,
}

impl fmt::Display for RetentionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(_) => {
                formatter.write_str("Feedgen NG projection retention could not start")
            }
            Self::NotCaughtUp => {
                formatter.write_str("Feedgen NG projection retention is not caught up")
            }
        }
    }
}

impl std::error::Error for RetentionError {}

/// Runs bounded local-data deletion passes without holding the SQLite writer for long.
pub struct RetentionCompactor {
    shutdown: watch::Sender<bool>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

impl RetentionCompactor {
    /// Runs an initial pass before feeds can open, then repeats short background passes.
    pub fn start(
        lifecycle: Arc<ControlLifecycle>,
        retention: ProjectionRetention,
    ) -> Result<Self, RetentionError> {
        compact_until_current(&lifecycle, &retention)?;
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(run_forever(lifecycle, retention, receiver));
        Ok(Self {
            shutdown,
            task: tokio::sync::Mutex::new(Some(task)),
        })
    }

    pub async fn stop(&self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}

async fn run_forever(
    lifecycle: Arc<ControlLifecycle>,
    retention: ProjectionRetention,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = tokio::time::sleep(COMPACTION_INTERVAL) => {
                if compact_bounded(&lifecycle, &retention).is_err() {
                    lifecycle.mark_unavailable();
                    return;
                }
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
    }
}

fn compact_once(
    lifecycle: &ControlLifecycle,
    retention: &ProjectionRetention,
) -> Result<ProjectionCompaction, StoreError> {
    let now = OffsetDateTime::now_utc();
    let seconds = i64::try_from(retention.max_age.as_secs())
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    let maximum_retained_at = now
        .checked_add(time::Duration::seconds(seconds))
        .ok_or(StoreError::InvalidProjectionMutation)?;
    lifecycle.compact_projection(
        &format_utc_millis(now),
        &format_utc_millis(maximum_retained_at),
        retention.max_bytes,
        COMPACTION_BATCH,
    )
}

fn compact_until_current(
    lifecycle: &ControlLifecycle,
    retention: &ProjectionRetention,
) -> Result<(), RetentionError> {
    for _ in 0..MAX_STARTUP_PASSES {
        if !compact_once(lifecycle, retention)
            .map_err(RetentionError::Store)?
            .has_more
        {
            return Ok(());
        }
    }
    Err(RetentionError::NotCaughtUp)
}

fn compact_bounded(
    lifecycle: &ControlLifecycle,
    retention: &ProjectionRetention,
) -> Result<(), StoreError> {
    for _ in 0..MAX_BACKGROUND_PASSES {
        if !compact_once(lifecycle, retention)?.has_more {
            break;
        }
    }
    Ok(())
}

fn format_utc_millis(value: OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond(),
    )
}

#[cfg(test)]
mod tests {
    use time::OffsetDateTime;

    use super::format_utc_millis;

    #[test]
    fn formats_store_compatible_compaction_timestamps() {
        assert_eq!(
            format_utc_millis(OffsetDateTime::from_unix_timestamp(0).unwrap()),
            "1970-01-01T00:00:00.000Z"
        );
    }
}

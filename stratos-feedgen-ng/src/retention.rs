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

#[derive(Debug)]
pub enum RetentionError {
    Store(StoreError),
}

impl fmt::Display for RetentionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Feedgen NG projection retention could not start")
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
        compact_until_current(&lifecycle, &retention).map_err(RetentionError::Store)?;
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
    lifecycle.compact_projection(
        &format_utc_millis(OffsetDateTime::now_utc()),
        retention.max_bytes,
        COMPACTION_BATCH,
    )
}

fn compact_until_current(
    lifecycle: &ControlLifecycle,
    retention: &ProjectionRetention,
) -> Result<(), StoreError> {
    while compact_once(lifecycle, retention)?.has_more {}
    Ok(())
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

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
    lifecycle.compact_projection_with_reserve(
        &format_utc_millis(now),
        &format_utc_millis(maximum_retained_at),
        retention.max_bytes,
        COMPACTION_BATCH,
        retention.space_write_reserve_bytes,
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
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use time::OffsetDateTime;

    use super::{compact_until_current, format_utc_millis};
    use crate::{
        config::ProjectionRetention,
        lifecycle::ControlLifecycle,
        readiness::FeedReadinessGate,
        service::ProjectionReader,
        store::{ActorPage, EncryptedStore, ProjectionPost, StorageKey},
    };

    #[test]
    fn formats_store_compatible_compaction_timestamps() {
        assert_eq!(
            format_utc_millis(OffsetDateTime::from_unix_timestamp(0).unwrap()),
            "1970-01-01T00:00:00.000Z"
        );
    }

    // Four posts of about 1,200 bytes under a 9,000-byte maximum. A 4,000-byte
    // reserve leaves room for all four; the default half does not, and a pass
    // over capacity evicts a whole batch.
    #[test]
    fn the_compactor_keeps_the_configured_space_write_reserve_free() {
        let lifecycle = ControlLifecycle::new(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
        );
        let retained_at = format_utc_millis(OffsetDateTime::now_utc() + time::Duration::hours(1));
        lifecycle
            .apply_actor_page(ActorPage {
                authority_did: "did:web:stratos.example.test".to_owned(),
                actor_did: "did:plc:spikespiegel".to_owned(),
                sequence: 1,
                upserts: ["callisto", "ganymede", "io", "titan"]
                    .iter()
                    .enumerate()
                    .map(|(day, rkey)| ProjectionPost {
                        uri: format!("at://did:plc:spikespiegel/zone.stratos.feed.post/{rkey}"),
                        author_did: "did:plc:spikespiegel".to_owned(),
                        cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .to_owned(),
                        sort_at: format!("1998-04-{:02}T00:00:00.000Z", day + 1),
                        indexed_at: "1998-04-01T00:00:00.000Z".to_owned(),
                        retained_at: retained_at.clone(),
                        record_json: format!(r#"{{"text":"{}"}}"#, "x".repeat(1_000)).into_bytes(),
                        blob_refs_json: b"[]".to_vec(),
                        boundaries: vec!["bebop".to_owned()],
                    })
                    .collect(),
                deletes: Vec::new(),
                interactions: crate::store::InteractionChanges::default(),
                updated_at: "1998-04-01T00:00:00.000Z".to_owned(),
            })
            .unwrap();

        compact_until_current(
            &lifecycle,
            &ProjectionRetention {
                max_age: Duration::from_secs(24 * 60 * 60),
                max_bytes: 9_000,
                space_write_reserve_bytes: 4_000,
            },
        )
        .unwrap();

        let posts = lifecycle.read(|projection| {
            projection
                .table_snapshot()
                .into_iter()
                .find(|(table, _)| table == "post")
                .map(|(_, rows)| rows.len())
        });
        assert_eq!(posts, Some(4));
    }
}

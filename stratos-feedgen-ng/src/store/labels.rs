use std::collections::{BTreeMap, BTreeSet};

use super::{
    actor::{load_actor_enrollment, unenroll_actor},
    *,
};
use crate::moderation_label::{LabelPage, LabelSubject};

const MAX_REINSTATING_PAGE: u16 = 256;
const TAKEDOWN_STATE: &str = "takedown";
const REINSTATING_STATE: &str = "reinstating";

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LabelPageEffects {
    pub taken_down: Vec<LabelSubject>,
    pub reinstating: Vec<LabelSubject>,
    pub unenrolled_boundaries: Vec<String>,
    pub removed_blobs: Vec<(String, String)>,
    pub removed_record_boundaries: Vec<String>,
}

pub(super) fn account_taken_down(connection: &Connection, did: &str) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM label_subject
             WHERE subject_kind = 'account' AND subject_key = ?1 AND state = ?2)",
            params![did, TAKEDOWN_STATE],
            |row| row.get(0),
        )
        .map_err(StoreError::Open)
}

// Matches under any authority so a label cannot be outrun by a different issuer.
pub(super) fn record_taken_down(connection: &Connection, uri: &str) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM label_subject
             WHERE subject_kind = 'record' AND subject_key = ?1 AND state = ?2)",
            params![uri, TAKEDOWN_STATE],
            |row| row.get(0),
        )
        .map_err(StoreError::Open)
}

#[derive(Default)]
struct RemovedPost {
    blobs: Vec<(String, String)>,
    boundaries: Vec<String>,
}

fn remove_taken_down_post(
    transaction: &rusqlite::Transaction<'_>,
    uri: &str,
) -> Result<RemovedPost, StoreError> {
    let stored: Option<(String, Vec<u8>)> = transaction
        .query_row(
            "SELECT author_did, blob_refs_json FROM post WHERE uri = ?1",
            [uri],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StoreError::Open)?;
    let Some((author_did, blob_refs_json)) = stored else {
        return Ok(RemovedPost::default());
    };
    let boundaries = transaction
        .prepare("SELECT boundary FROM post_boundary WHERE uri = ?1")
        .map_err(StoreError::Open)?
        .query_map([uri], |row| row.get::<_, String>(0))
        .map_err(StoreError::Open)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::Open)?;
    transaction
        .execute("DELETE FROM post WHERE uri = ?1", [uri])
        .map_err(StoreError::Open)?;
    // A reference that cannot be read has nothing cached under a usable cid.
    let references: Vec<serde_json::Value> =
        serde_json::from_slice(&blob_refs_json).unwrap_or_default();
    let blobs = references
        .iter()
        .filter_map(|reference| reference.get("cid")?.as_str())
        .map(|cid| (author_did.clone(), cid.to_owned()))
        .collect();
    Ok(RemovedPost { blobs, boundaries })
}

fn remove_taken_down_interaction(
    transaction: &rusqlite::Transaction<'_>,
    uri: &str,
) -> Result<Option<String>, StoreError> {
    let boundary: Option<String> = transaction
        .query_row(
            "SELECT boundary FROM interaction WHERE uri = ?1",
            [uri],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::Open)?;
    if boundary.is_some() {
        super::interactions::delete_interaction(transaction, uri)?;
    }
    Ok(boundary)
}

fn subject_key(subject: &LabelSubject) -> &str {
    match subject {
        LabelSubject::Record { uri, .. } => uri,
        LabelSubject::Account { did } => did,
    }
}

fn subject_columns(subject: &LabelSubject) -> (&'static str, &str) {
    match subject {
        LabelSubject::Record { author_did, .. } => ("record", author_did),
        LabelSubject::Account { did } => ("account", did),
    }
}

impl EncryptedStore {
    pub fn label_cursor(&self, authority_did: &str) -> Result<u64, StoreError> {
        let sequence: Option<i64> = self
            .connection
            .query_row(
                "SELECT sequence FROM label_cursor WHERE authority_did = ?1",
                [authority_did],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::Open)?;
        Ok(sequence.map_or(0, |value| u64::try_from(value).unwrap_or(0)))
    }

    pub fn apply_label_page(
        &mut self,
        authority_did: &str,
        page: &LabelPage,
        updated_at: &str,
    ) -> Result<LabelPageEffects, StoreError> {
        let cursor =
            i64::try_from(page.cursor).map_err(|_| StoreError::InvalidProjectionMutation)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        let current: Option<i64> = transaction
            .query_row(
                "SELECT sequence FROM label_cursor WHERE authority_did = ?1",
                [authority_did],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::Open)?;
        if current.is_some_and(|stored| stored > cursor) {
            return Err(StoreError::StaleCursor);
        }
        // A later label on the same subject supersedes an earlier one on this page.
        let mut final_states: BTreeMap<&str, (&LabelSubject, bool)> = BTreeMap::new();
        for label in &page.labels {
            let sequence =
                i64::try_from(label.seq).map_err(|_| StoreError::InvalidProjectionMutation)?;
            let key = subject_key(&label.subject);
            let (kind, author_did) = subject_columns(&label.subject);
            if label.neg {
                let reinstated = transaction
                    .execute(
                        "UPDATE label_subject SET state = ?3, attempts = 0, label_sequence = ?4
                         WHERE authority_did = ?1 AND subject_key = ?2 AND state = ?5",
                        params![
                            authority_did,
                            key,
                            REINSTATING_STATE,
                            sequence,
                            TAKEDOWN_STATE
                        ],
                    )
                    .map_err(StoreError::Open)?;
                if reinstated > 0 {
                    final_states.insert(key, (&label.subject, false));
                }
            } else {
                transaction
                    .execute(
                        "INSERT INTO label_subject (authority_did, subject_key, subject_kind, author_did, label_sequence, state, attempts)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
                         ON CONFLICT(authority_did, subject_key) DO UPDATE SET
                           subject_kind = excluded.subject_kind, author_did = excluded.author_did,
                           label_sequence = excluded.label_sequence, state = excluded.state, attempts = 0",
                        params![authority_did, key, kind, author_did, sequence, TAKEDOWN_STATE],
                    )
                    .map_err(StoreError::Open)?;
                final_states.insert(key, (&label.subject, true));
            }
        }
        let mut unenrolled_boundaries = BTreeSet::new();
        for (subject, taken_down) in final_states.values() {
            let LabelSubject::Account { did } = subject else {
                continue;
            };
            if !*taken_down {
                continue;
            }
            if !is_utc_timestamp(updated_at) {
                return Err(StoreError::InvalidProjectionMutation);
            }
            let previous = load_actor_enrollment(&transaction, did)?;
            // Keeps the stored observation time from moving backwards when the
            // local clock trails the authority's enrollment time.
            let observed_at = previous
                .as_ref()
                .map_or(updated_at, |stored| {
                    stored.observed_at.as_str().max(updated_at)
                })
                .to_owned();
            let unenrolled = unenroll_actor(&transaction, did, previous, &observed_at)?;
            unenrolled_boundaries.extend(unenrolled.removed_boundaries);
            unenrolled_boundaries.extend(unenrolled.pds_boundaries);
        }
        let mut removed_blobs = Vec::new();
        let mut removed_record_boundaries = BTreeSet::new();
        for (subject, taken_down) in final_states.values() {
            let LabelSubject::Record { uri, .. } = subject else {
                continue;
            };
            if !*taken_down {
                continue;
            }
            let removed = remove_taken_down_post(&transaction, uri)?;
            removed_blobs.extend(removed.blobs);
            removed_record_boundaries.extend(removed.boundaries);
            removed_record_boundaries.extend(remove_taken_down_interaction(&transaction, uri)?);
        }
        transaction
            .execute(
                "INSERT INTO label_cursor (authority_did, sequence, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(authority_did) DO UPDATE SET sequence = excluded.sequence, updated_at = excluded.updated_at",
                params![authority_did, cursor, updated_at],
            )
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)?;
        let mut effects = LabelPageEffects {
            unenrolled_boundaries: unenrolled_boundaries.into_iter().collect(),
            removed_blobs,
            removed_record_boundaries: removed_record_boundaries.into_iter().collect(),
            ..LabelPageEffects::default()
        };
        for (subject, taken_down) in final_states.into_values() {
            if taken_down {
                effects.taken_down.push(subject.clone());
            } else {
                effects.reinstating.push(subject.clone());
            }
        }
        Ok(effects)
    }

    #[cfg(test)]
    pub(crate) fn is_taken_down(
        &self,
        authority_did: &str,
        subject_key: &str,
    ) -> Result<bool, StoreError> {
        self.connection
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM label_subject
                 WHERE authority_did = ?1 AND subject_key = ?2 AND state = ?3)",
                params![authority_did, subject_key, TAKEDOWN_STATE],
                |row| row.get(0),
            )
            .map_err(StoreError::Open)
    }

    #[cfg(test)]
    pub(crate) fn reinstating_subjects(
        &self,
        authority_did: &str,
        limit: u16,
    ) -> Result<Vec<(LabelSubject, u32)>, StoreError> {
        if limit == 0 || limit > MAX_REINSTATING_PAGE {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT subject_key, subject_kind, author_did, attempts FROM label_subject
                 WHERE authority_did = ?1 AND state = ?2
                 ORDER BY label_sequence, subject_key LIMIT ?3",
            )
            .map_err(StoreError::Open)?;
        let rows = statement
            .query_map(
                params![authority_did, REINSTATING_STATE, i64::from(limit)],
                |row| {
                    let key: String = row.get(0)?;
                    let kind: String = row.get(1)?;
                    let author_did: String = row.get(2)?;
                    let attempts: u32 = row.get(3)?;
                    let subject = if kind == "record" {
                        LabelSubject::Record {
                            uri: key,
                            author_did,
                        }
                    } else {
                        LabelSubject::Account { did: key }
                    };
                    Ok((subject, attempts))
                },
            )
            .map_err(StoreError::Open)?;
        rows.collect::<Result<_, _>>().map_err(StoreError::Open)
    }

    pub fn reinstating_accounts(
        &self,
        authority_did: &str,
        limit: u16,
    ) -> Result<Vec<(String, u32)>, StoreError> {
        if limit == 0 || limit > MAX_REINSTATING_PAGE {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT subject_key, attempts FROM label_subject
                 WHERE authority_did = ?1 AND state = ?2 AND subject_kind = 'account'
                 ORDER BY label_sequence, subject_key LIMIT ?3",
            )
            .map_err(StoreError::Open)?;
        let rows = statement
            .query_map(
                params![authority_did, REINSTATING_STATE, i64::from(limit)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(StoreError::Open)?;
        rows.collect::<Result<_, _>>().map_err(StoreError::Open)
    }

    pub fn is_account_taken_down(&self, did: &str) -> Result<bool, StoreError> {
        account_taken_down(&self.connection, did)
    }

    pub fn reinstating_records(
        &self,
        authority_did: &str,
        limit: u16,
    ) -> Result<Vec<String>, StoreError> {
        if limit == 0 || limit > MAX_REINSTATING_PAGE {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT subject_key FROM label_subject
                 WHERE authority_did = ?1 AND state = ?2 AND subject_kind = 'record'
                 ORDER BY label_sequence, subject_key LIMIT ?3",
            )
            .map_err(StoreError::Open)?;
        let rows = statement
            .query_map(
                params![authority_did, REINSTATING_STATE, i64::from(limit)],
                |row| row.get(0),
            )
            .map_err(StoreError::Open)?;
        rows.collect::<Result<_, _>>().map_err(StoreError::Open)
    }

    pub fn finish_reinstatement(
        &mut self,
        authority_did: &str,
        subject_key: &str,
    ) -> Result<(), StoreError> {
        self.connection
            .execute(
                "DELETE FROM label_subject
                 WHERE authority_did = ?1 AND subject_key = ?2 AND state = ?3",
                params![authority_did, subject_key, REINSTATING_STATE],
            )
            .map_err(StoreError::Open)?;
        Ok(())
    }

    pub fn record_reinstatement_attempt(
        &mut self,
        authority_did: &str,
        subject_key: &str,
    ) -> Result<(), StoreError> {
        self.connection
            .execute(
                "UPDATE label_subject SET attempts = attempts + 1
                 WHERE authority_did = ?1 AND subject_key = ?2 AND state = ?3",
                params![authority_did, subject_key, REINSTATING_STATE],
            )
            .map_err(StoreError::Open)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::moderation_label::ModerationLabel;

    const AUTHORITY: &str = "did:web:stratos.example.test";
    const SPIKE_POST: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/bebop1";
    const FAYE_SPACE_POST: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop/did:plc:fayevalentine/zone.stratos.feed.post/swordfish";
    const UPDATED_AT: &str = "2026-11-01T00:00:00.000Z";

    fn key() -> StorageKey {
        StorageKey::from_bytes([7; 32])
    }

    fn spike_subject() -> LabelSubject {
        LabelSubject::Record {
            uri: SPIKE_POST.to_owned(),
            author_did: "did:plc:spikespiegel".to_owned(),
        }
    }

    fn label(seq: u64, subject: LabelSubject, neg: bool) -> ModerationLabel {
        ModerationLabel { seq, subject, neg }
    }

    fn page(cursor: u64, labels: Vec<ModerationLabel>) -> LabelPage {
        LabelPage {
            cursor,
            labels,
            skipped_subjects: 0,
        }
    }

    fn database_path(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "stratos-feedgen-ng-labels-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn a_takedown_is_recorded_with_the_page_cursor() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        let effects = store
            .apply_label_page(
                AUTHORITY,
                &page(4, vec![label(3, spike_subject(), false)]),
                UPDATED_AT,
            )
            .unwrap();
        assert!(store.is_taken_down(AUTHORITY, SPIKE_POST).unwrap());
        assert_eq!(store.label_cursor(AUTHORITY).unwrap(), 4);
        assert_eq!(effects.taken_down, [spike_subject()]);
        assert!(effects.reinstating.is_empty());
    }

    #[test]
    fn a_negation_on_the_same_page_leaves_the_subject_reinstating() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        let effects = store
            .apply_label_page(
                AUTHORITY,
                &page(
                    2,
                    vec![
                        label(1, spike_subject(), false),
                        label(2, spike_subject(), true),
                    ],
                ),
                UPDATED_AT,
            )
            .unwrap();
        assert!(!store.is_taken_down(AUTHORITY, SPIKE_POST).unwrap());
        assert_eq!(effects.reinstating, [spike_subject()]);
        assert!(effects.taken_down.is_empty());
        assert_eq!(
            store.reinstating_subjects(AUTHORITY, 10).unwrap(),
            [(spike_subject(), 0)]
        );
    }

    #[test]
    fn a_negation_without_a_takedown_stores_nothing_but_advances_the_cursor() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        let effects = store
            .apply_label_page(
                AUTHORITY,
                &page(6, vec![label(6, spike_subject(), true)]),
                UPDATED_AT,
            )
            .unwrap();
        assert_eq!(effects, LabelPageEffects::default());
        assert!(!store.is_taken_down(AUTHORITY, SPIKE_POST).unwrap());
        assert!(
            store
                .reinstating_subjects(AUTHORITY, 10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.label_cursor(AUTHORITY).unwrap(), 6);
    }

    #[test]
    fn a_stale_page_changes_neither_rows_nor_cursor() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .apply_label_page(AUTHORITY, &page(10, Vec::new()), UPDATED_AT)
            .unwrap();
        let result = store.apply_label_page(
            AUTHORITY,
            &page(5, vec![label(5, spike_subject(), false)]),
            UPDATED_AT,
        );
        assert!(matches!(result, Err(StoreError::StaleCursor)));
        assert!(!store.is_taken_down(AUTHORITY, SPIKE_POST).unwrap());
        assert_eq!(store.label_cursor(AUTHORITY).unwrap(), 10);
        store
            .apply_label_page(AUTHORITY, &page(10, Vec::new()), UPDATED_AT)
            .unwrap();
    }

    #[test]
    fn a_failure_inside_the_transaction_rolls_back_rows_and_cursor() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        let unstorable_sequence = u64::MAX;
        let result = store.apply_label_page(
            AUTHORITY,
            &page(
                9,
                vec![
                    label(5, spike_subject(), false),
                    label(
                        unstorable_sequence,
                        LabelSubject::Account {
                            did: "did:plc:edwardwong".to_owned(),
                        },
                        false,
                    ),
                ],
            ),
            UPDATED_AT,
        );
        assert!(matches!(result, Err(StoreError::InvalidProjectionMutation)));
        assert_eq!(store.label_cursor(AUTHORITY).unwrap(), 0);
        assert!(!store.is_taken_down(AUTHORITY, SPIKE_POST).unwrap());
    }

    #[test]
    fn cursor_and_takedowns_survive_a_restart() {
        let path = database_path("restart");
        let mut store = EncryptedStore::open(&path, key()).unwrap();
        store
            .apply_label_page(
                AUTHORITY,
                &page(
                    3,
                    vec![
                        label(1, spike_subject(), false),
                        label(
                            2,
                            LabelSubject::Account {
                                did: "did:plc:edwardwong".to_owned(),
                            },
                            false,
                        ),
                        label(3, spike_subject(), true),
                    ],
                ),
                UPDATED_AT,
            )
            .unwrap();
        drop(store);

        let reopened = EncryptedStore::open(&path, key()).unwrap();
        assert_eq!(reopened.label_cursor(AUTHORITY).unwrap(), 3);
        assert!(
            reopened
                .is_taken_down(AUTHORITY, "did:plc:edwardwong")
                .unwrap()
        );
        assert_eq!(
            reopened.reinstating_subjects(AUTHORITY, 10).unwrap(),
            [(spike_subject(), 0)]
        );
        drop(reopened);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn finishing_a_reinstatement_leaves_a_retaken_down_subject_alone() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .apply_label_page(
                AUTHORITY,
                &page(
                    3,
                    vec![
                        label(1, spike_subject(), false),
                        label(2, spike_subject(), true),
                        label(3, spike_subject(), false),
                    ],
                ),
                UPDATED_AT,
            )
            .unwrap();
        store.finish_reinstatement(AUTHORITY, SPIKE_POST).unwrap();
        assert!(store.is_taken_down(AUTHORITY, SPIKE_POST).unwrap());
    }

    #[test]
    fn finishing_a_reinstatement_removes_the_row_and_attempts_are_counted() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .apply_label_page(
                AUTHORITY,
                &page(
                    2,
                    vec![
                        label(1, spike_subject(), false),
                        label(2, spike_subject(), true),
                    ],
                ),
                UPDATED_AT,
            )
            .unwrap();
        store
            .record_reinstatement_attempt(AUTHORITY, SPIKE_POST)
            .unwrap();
        assert_eq!(
            store.reinstating_subjects(AUTHORITY, 10).unwrap(),
            [(spike_subject(), 1)]
        );
        store.finish_reinstatement(AUTHORITY, SPIKE_POST).unwrap();
        assert!(
            store
                .reinstating_subjects(AUTHORITY, 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_member_who_was_unenrolled_can_be_enrolled_again() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        let enroll = |store: &mut EncryptedStore, observed_at: &str| {
            store.reconcile_actor_enrollment(
                "did:plc:spikespiegel",
                observed_at,
                Some(ActorEnrollment {
                    did: "did:plc:spikespiegel".to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    observed_at: observed_at.to_owned(),
                }),
            )
        };
        enroll(&mut store, "1998-04-03T00:00:00.000Z").unwrap();
        store
            .reconcile_actor_enrollment("did:plc:spikespiegel", "1998-04-04T00:00:00.000Z", None)
            .unwrap();

        let again = enroll(&mut store, "1998-04-05T00:00:00.000Z").unwrap();

        assert!(again.enrolled);
    }

    #[test]
    fn an_unenrollment_stores_the_boundary_list_as_a_blob() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .reconcile_actor_enrollment("did:plc:spikespiegel", "1998-04-03T00:00:00.000Z", None)
            .unwrap();

        let storage_type: String = store
            .connection
            .query_row(
                "SELECT typeof(boundaries_json) FROM actor_enrollment WHERE did = ?1",
                ["did:plc:spikespiegel"],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(storage_type, "blob");
    }

    #[test]
    fn an_unenrollment_row_stored_as_text_still_loads_and_can_be_enrolled_again() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .connection
            .execute(
                "INSERT INTO actor_enrollment (did, boundaries_json, observed_at, enrolled) VALUES (?1, '[]', ?2, 0)",
                params!["did:plc:spikespiegel", "1998-04-03T00:00:00.000Z"],
            )
            .unwrap();

        let again = store
            .reconcile_actor_enrollment(
                "did:plc:spikespiegel",
                "1998-04-04T00:00:00.000Z",
                Some(ActorEnrollment {
                    did: "did:plc:spikespiegel".to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    observed_at: "1998-04-04T00:00:00.000Z".to_owned(),
                }),
            )
            .unwrap();

        assert!(again.enrolled);
    }

    #[test]
    fn a_space_record_subject_stores_the_author_segment() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        let subject = LabelSubject::Record {
            uri: FAYE_SPACE_POST.to_owned(),
            author_did: "did:plc:fayevalentine".to_owned(),
        };
        store
            .apply_label_page(
                AUTHORITY,
                &page(1, vec![label(1, subject, false)]),
                UPDATED_AT,
            )
            .unwrap();
        let stored_author: String = store
            .connection
            .query_row(
                "SELECT author_did FROM label_subject WHERE subject_key = ?1",
                [FAYE_SPACE_POST],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_author, "did:plc:fayevalentine");
    }

    #[test]
    fn upgrading_from_version_seven_keeps_existing_posts() {
        let path = database_path("upgrade");
        let mut version_seven = Connection::open(&path).unwrap();
        version_seven
            .execute_batch(&format!(
                "PRAGMA key = \"x'{}'\"; PRAGMA foreign_keys = ON;",
                key().as_hex()
            ))
            .unwrap();
        migrations::apply_through(&mut version_seven, 7).unwrap();
        version_seven
            .execute_batch(&format!(
                "INSERT INTO post (uri, author_did, cid, sort_at, indexed_at, retained_at, projection_bytes, record_json, blob_refs_json, row_version)
                   VALUES ('{SPIKE_POST}', 'did:plc:spikespiegel', 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                           '1998-04-03T00:00:00.000Z', '1998-04-03T00:00:01.000Z', '1998-04-04T00:00:00.000Z', 64,
                           CAST('{{\"text\":\"Bang\"}}' AS BLOB), CAST('[]' AS BLOB), 0);
                 INSERT INTO post_boundary (uri, boundary, sort_at)
                   VALUES ('{SPIKE_POST}', 'bebop', '1998-04-03T00:00:00.000Z');"
            ))
            .unwrap();
        drop(version_seven);

        let upgraded = EncryptedStore::open(&path, key()).unwrap();
        let posts: i64 = upgraded
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0))
            .unwrap();
        assert_eq!(posts, 1);
        assert_eq!(upgraded.label_cursor(AUTHORITY).unwrap(), 0);
        drop(upgraded);
        let _ = std::fs::remove_file(&path);
    }

    const SPIKE_DID: &str = "did:plc:spikespiegel";
    const SPIKE_SECOND_POST: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/bebop2";
    const SPIKE_BLOB_CID: &str = "bafkreiswordfish";

    fn spike_post_at(uri: &str, blob_refs_json: &[u8]) -> ProjectionPost {
        ProjectionPost {
            uri: uri.to_owned(),
            author_did: SPIKE_DID.to_owned(),
            cid: "bafyreia".to_owned(),
            sort_at: "1998-04-03T00:00:00.000Z".to_owned(),
            indexed_at: "1998-04-03T00:00:01.000Z".to_owned(),
            retained_at: "1998-04-04T00:00:00.000Z".to_owned(),
            record_json: br#"{"text":"Bang"}"#.to_vec(),
            blob_refs_json: blob_refs_json.to_vec(),
            boundaries: vec!["bebop".to_owned()],
        }
    }

    fn spike_blob_post() -> ProjectionPost {
        spike_post_at(
            SPIKE_POST,
            format!(r#"[{{"cid":"{SPIKE_BLOB_CID}","mimeType":"image/png"}}]"#).as_bytes(),
        )
    }

    fn spike_page(sequence: u64, upserts: Vec<ProjectionPost>, deletes: Vec<String>) -> ActorPage {
        ActorPage {
            authority_did: AUTHORITY.to_owned(),
            actor_did: SPIKE_DID.to_owned(),
            sequence,
            upserts,
            deletes,
            updated_at: UPDATED_AT.to_owned(),
            interactions: crate::store::InteractionChanges::default(),
        }
    }

    fn takedown_page(cursor: u64) -> LabelPage {
        page(cursor, vec![label(cursor, spike_subject(), false)])
    }

    fn stored_posts(store: &EncryptedStore, uri: &str) -> i64 {
        store
            .connection
            .query_row("SELECT COUNT(*) FROM post WHERE uri = ?1", [uri], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn stored_actor_cursor(store: &EncryptedStore) -> i64 {
        store
            .connection
            .query_row(
                "SELECT sequence FROM actor_cursor WHERE did = ?1",
                [SPIKE_DID],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn a_record_takedown_removes_the_post_and_reports_its_blobs_and_boundaries() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .apply_actor_page(spike_page(
                1,
                vec![spike_blob_post(), spike_post_at(SPIKE_SECOND_POST, b"[]")],
                Vec::new(),
            ))
            .unwrap();

        let effects = store
            .apply_label_page(AUTHORITY, &takedown_page(2), UPDATED_AT)
            .unwrap();

        assert_eq!(stored_posts(&store, SPIKE_POST), 0);
        assert_eq!(stored_posts(&store, SPIKE_SECOND_POST), 1);
        assert_eq!(
            effects.removed_blobs,
            [(SPIKE_DID.to_owned(), SPIKE_BLOB_CID.to_owned())]
        );
        assert_eq!(effects.removed_record_boundaries, ["bebop"]);
        let boundary_rows: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM post_boundary WHERE uri = ?1",
                [SPIKE_POST],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(boundary_rows, 0);
    }

    #[test]
    fn a_takedown_negated_on_the_same_page_keeps_the_post() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .apply_actor_page(spike_page(1, vec![spike_blob_post()], Vec::new()))
            .unwrap();

        let effects = store
            .apply_label_page(
                AUTHORITY,
                &page(
                    3,
                    vec![
                        label(2, spike_subject(), false),
                        label(3, spike_subject(), true),
                    ],
                ),
                UPDATED_AT,
            )
            .unwrap();

        assert_eq!(stored_posts(&store, SPIKE_POST), 1);
        assert!(effects.removed_blobs.is_empty());
        assert!(effects.removed_record_boundaries.is_empty());
    }

    #[test]
    fn a_later_update_does_not_readmit_a_taken_down_post_but_advances_the_cursor() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .apply_actor_page(spike_page(
                1,
                vec![spike_blob_post(), spike_post_at(SPIKE_SECOND_POST, b"[]")],
                Vec::new(),
            ))
            .unwrap();
        store
            .apply_label_page(AUTHORITY, &takedown_page(2), UPDATED_AT)
            .unwrap();

        store
            .apply_actor_page(spike_page(
                5,
                vec![spike_blob_post()],
                vec![SPIKE_SECOND_POST.to_owned()],
            ))
            .unwrap();

        assert_eq!(stored_posts(&store, SPIKE_POST), 0);
        assert_eq!(stored_posts(&store, SPIKE_SECOND_POST), 0);
        assert_eq!(stored_actor_cursor(&store), 5);
    }

    #[test]
    fn a_replay_from_the_start_does_not_readmit_a_taken_down_post() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .apply_actor_page(spike_page(1, vec![spike_blob_post()], Vec::new()))
            .unwrap();
        store
            .apply_label_page(AUTHORITY, &takedown_page(2), UPDATED_AT)
            .unwrap();
        store
            .connection
            .execute("DELETE FROM actor_cursor WHERE did = ?1", [SPIKE_DID])
            .unwrap();

        store
            .apply_actor_page(spike_page(1, vec![spike_blob_post()], Vec::new()))
            .unwrap();

        assert_eq!(stored_posts(&store, SPIKE_POST), 0);
    }

    #[test]
    fn a_label_for_a_post_not_yet_projected_refuses_its_later_creation() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        let effects = store
            .apply_label_page(AUTHORITY, &takedown_page(1), UPDATED_AT)
            .unwrap();
        assert!(store.is_taken_down(AUTHORITY, SPIKE_POST).unwrap());
        assert!(effects.removed_blobs.is_empty());
        assert!(effects.removed_record_boundaries.is_empty());

        store
            .apply_actor_page(spike_page(
                1,
                vec![spike_blob_post(), spike_post_at(SPIKE_SECOND_POST, b"[]")],
                Vec::new(),
            ))
            .unwrap();

        assert_eq!(stored_posts(&store, SPIKE_POST), 0);
        assert_eq!(stored_posts(&store, SPIKE_SECOND_POST), 1);
    }

    const FAYE: &str = "did:plc:fayevalentine";
    const JET: &str = "did:plc:jetblack";
    const BEBOP_BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const BEBOP_SPACE: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop";

    fn second_spike_subject() -> LabelSubject {
        LabelSubject::Record {
            uri: SPIKE_SECOND_POST.to_owned(),
            author_did: SPIKE_DID.to_owned(),
        }
    }

    #[test]
    fn reinstating_records_lists_only_record_subjects_oldest_negation_first() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        let faye = LabelSubject::Account {
            did: FAYE.to_owned(),
        };
        store
            .apply_label_page(
                AUTHORITY,
                &page(
                    6,
                    vec![
                        label(1, spike_subject(), false),
                        label(2, second_spike_subject(), false),
                        label(3, faye.clone(), false),
                        label(4, second_spike_subject(), true),
                        label(5, faye, true),
                        label(6, spike_subject(), true),
                    ],
                ),
                UPDATED_AT,
            )
            .unwrap();

        assert_eq!(
            store.reinstating_records(AUTHORITY, 10).unwrap(),
            [SPIKE_SECOND_POST.to_owned(), SPIKE_POST.to_owned()]
        );
        assert_eq!(store.reinstating_records(AUTHORITY, 1).unwrap().len(), 1);
        assert!(store.reinstating_records(AUTHORITY, 0).is_err());
    }

    #[test]
    fn a_record_that_is_still_taken_down_is_not_reinstating() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .apply_label_page(AUTHORITY, &takedown_page(1), UPDATED_AT)
            .unwrap();

        assert!(store.reinstating_records(AUTHORITY, 10).unwrap().is_empty());
    }

    #[test]
    fn resetting_an_actor_cursor_leaves_its_posts_and_other_actors_alone() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .apply_actor_page(spike_page(4, vec![spike_blob_post()], Vec::new()))
            .unwrap();
        store
            .apply_actor_page(ActorPage {
                actor_did: FAYE.to_owned(),
                ..spike_page(9, Vec::new(), Vec::new())
            })
            .unwrap();

        store.reset_actor_cursor(AUTHORITY, SPIKE_DID).unwrap();

        let cursors = |did: &str| -> i64 {
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM actor_cursor WHERE did = ?1",
                    [did],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(cursors(SPIKE_DID), 0);
        assert_eq!(cursors(FAYE), 1);
        assert_eq!(stored_posts(&store, SPIKE_POST), 1);
    }

    #[test]
    fn resetting_a_pds_member_forgets_only_that_members_sync_position() {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        store
            .replace_pds_space_members(
                BEBOP_BOUNDARY,
                vec![
                    PdsSpaceMember {
                        did: FAYE.to_owned(),
                    },
                    PdsSpaceMember {
                        did: JET.to_owned(),
                    },
                ],
                UPDATED_AT,
            )
            .unwrap();
        let swordfish = serde_json::json!({
            "$type": "zone.stratos.feed.post",
            "createdAt": "1998-04-03T00:00:00.000Z"
        });
        store
            .publish_verified_records(
                BEBOP_BOUNDARY,
                BEBOP_SPACE,
                FAYE,
                &[("zone.stratos.feed.post", "swordfish", swordfish)],
                "2026-11-02T00:00:00.000Z",
                UPDATED_AT,
            )
            .unwrap();
        store
            .publish_verified_records(
                BEBOP_BOUNDARY,
                BEBOP_SPACE,
                JET,
                &[],
                "2026-11-02T00:00:00.000Z",
                UPDATED_AT,
            )
            .unwrap();
        let base_of = |store: &EncryptedStore, did: &str| {
            store
                .verified_space_base(BEBOP_SPACE, did)
                .unwrap()
                .map(|base| base.rev)
        };
        assert!(base_of(&store, FAYE).is_some());
        store
            .reset_pds_member_space_state(BEBOP_BOUNDARY, FAYE)
            .unwrap();

        assert_eq!(base_of(&store, FAYE), None);
        assert!(base_of(&store, JET).is_some());
        assert_eq!(stored_posts(&store, FAYE_SPACE_POST), 1);
        assert!(
            store
                .is_current_pds_space_member(BEBOP_BOUNDARY, FAYE)
                .unwrap()
        );
    }
}

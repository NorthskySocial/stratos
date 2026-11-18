use super::*;

/// Accounts for index and row overhead that the text columns alone do not.
const INTERACTION_ROW_OVERHEAD_BYTES: i64 = 64;
pub(crate) const MAX_SUBJECT_URI_BYTES: usize = 2_048;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InteractionKind {
    Like,
    Repost,
}

impl InteractionKind {
    pub const ALL: [Self; 2] = [Self::Like, Self::Repost];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Like => "like",
            Self::Repost => "repost",
        }
    }

    pub fn collection(self) -> &'static str {
        match self {
            Self::Like => "app.bsky.feed.like",
            Self::Repost => "app.bsky.feed.repost",
        }
    }

    pub fn from_collection(collection: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.collection() == collection)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionInteraction {
    pub uri: String,
    pub actor_did: String,
    pub kind: InteractionKind,
    pub subject_uri: String,
    pub boundary: String,
    pub indexed_at: String,
    pub retained_at: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InteractionChanges {
    pub upserts: Vec<ProjectionInteraction>,
    pub deletes: Vec<String>,
}

pub(super) fn upsert_interaction(
    transaction: &rusqlite::Transaction<'_>,
    interaction: &ProjectionInteraction,
) -> Result<bool, StoreError> {
    validate_interaction(interaction)?;
    // A replay or a later update must not re-admit a taken-down record.
    if super::labels::record_taken_down(transaction, &interaction.uri)? {
        return Ok(false);
    }
    transaction
        .execute(
            "INSERT INTO interaction (uri, actor_did, kind, subject_uri, boundary, indexed_at, retained_at, projection_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(uri) DO UPDATE SET actor_did = excluded.actor_did, kind = excluded.kind,
               subject_uri = excluded.subject_uri, boundary = excluded.boundary,
               indexed_at = excluded.indexed_at, retained_at = excluded.retained_at,
               projection_bytes = excluded.projection_bytes",
            params![
                interaction.uri,
                interaction.actor_did,
                interaction.kind.as_str(),
                interaction.subject_uri,
                interaction.boundary,
                interaction.indexed_at,
                interaction.retained_at,
                interaction_bytes(interaction),
            ],
        )
        .map_err(StoreError::Open)?;
    Ok(true)
}

pub(super) fn delete_interaction(
    transaction: &rusqlite::Transaction<'_>,
    uri: &str,
) -> Result<usize, StoreError> {
    transaction
        .execute("DELETE FROM interaction WHERE uri = ?1", [uri])
        .map_err(StoreError::Open)
}

pub(super) fn delete_actor_interactions(
    transaction: &rusqlite::Transaction<'_>,
    did: &str,
) -> Result<usize, StoreError> {
    transaction
        .execute("DELETE FROM interaction WHERE actor_did = ?1", [did])
        .map_err(StoreError::Open)
}

pub(super) fn delete_actor_boundary_interactions(
    transaction: &rusqlite::Transaction<'_>,
    did: &str,
    boundary: &str,
) -> Result<usize, StoreError> {
    transaction
        .execute(
            "DELETE FROM interaction WHERE actor_did = ?1 AND boundary = ?2",
            params![did, boundary],
        )
        .map_err(StoreError::Open)
}

pub(super) fn delete_boundary_interactions(
    transaction: &rusqlite::Transaction<'_>,
    boundary: &str,
) -> Result<usize, StoreError> {
    transaction
        .execute("DELETE FROM interaction WHERE boundary = ?1", [boundary])
        .map_err(StoreError::Open)
}

pub(super) fn delete_expired_interactions(
    transaction: &rusqlite::Transaction<'_>,
    as_of: &str,
    limit: i64,
) -> Result<usize, StoreError> {
    transaction
        .execute(
            "DELETE FROM interaction WHERE uri IN (
               SELECT uri FROM interaction WHERE retained_at <= ?1
               ORDER BY retained_at ASC, uri ASC LIMIT ?2)",
            params![as_of, limit],
        )
        .map_err(StoreError::Open)
}

/// Removes expired interactions and those kept past the configured maximum,
/// the rule compaction applies to posts, so a shortened retention policy also
/// reaches rows stored before it.
pub(super) fn delete_interactions_outside_retention(
    transaction: &rusqlite::Transaction<'_>,
    as_of: &str,
    maximum_retained_at: &str,
    limit: i64,
) -> Result<usize, StoreError> {
    transaction
        .execute(
            "DELETE FROM interaction WHERE uri IN (
               SELECT uri FROM interaction WHERE retained_at <= ?1 OR retained_at > ?2
               ORDER BY retained_at ASC, uri ASC LIMIT ?3)",
            params![as_of, maximum_retained_at, limit],
        )
        .map_err(StoreError::Open)
}

/// Removes interactions whose subject is not a post in the interaction's own
/// boundary, oldest first. Such rows can never be counted.
pub(super) fn evict_orphan_interactions(
    transaction: &rusqlite::Transaction<'_>,
    limit: i64,
) -> Result<usize, StoreError> {
    transaction
        .execute(
            "DELETE FROM interaction WHERE uri IN (
               SELECT candidate.uri FROM interaction AS candidate
               WHERE NOT EXISTS (
                 SELECT 1 FROM post_boundary
                 WHERE post_boundary.uri = candidate.subject_uri
                   AND post_boundary.boundary = candidate.boundary)
               ORDER BY candidate.retained_at ASC, candidate.uri ASC LIMIT ?1)",
            [limit],
        )
        .map_err(StoreError::Open)
}

pub(super) fn published_bytes(transaction: &rusqlite::Transaction<'_>) -> Result<i64, StoreError> {
    transaction
        .query_row(
            "SELECT (SELECT COALESCE(SUM(projection_bytes), 0) FROM post)
                  + (SELECT COALESCE(SUM(projection_bytes), 0) FROM interaction)",
            [],
            |row| row.get(0),
        )
        .map_err(StoreError::Open)
}

/// Checks every change against the actor that supplied the page, before any
/// of it is applied.
pub(super) fn validate_interaction_changes(
    changes: &InteractionChanges,
    actor_did: &str,
) -> Result<(), StoreError> {
    for interaction in &changes.upserts {
        validate_interaction(interaction)?;
        let uri = crate::identifier::RecordUri::parse(&interaction.uri)
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        if interaction.actor_did != actor_did
            || !matches!(uri, crate::identifier::RecordUri::Repo { .. })
        {
            return Err(StoreError::InvalidProjectionMutation);
        }
    }
    for uri in &changes.deletes {
        let uri = crate::identifier::RecordUri::parse(uri)
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        let is_interaction_collection =
            InteractionKind::from_collection(record_collection(&uri)).is_some();
        if uri.author().as_str() != actor_did
            || !matches!(uri, crate::identifier::RecordUri::Repo { .. })
            || !is_interaction_collection
        {
            return Err(StoreError::InvalidProjectionMutation);
        }
    }
    Ok(())
}

fn interaction_bytes(interaction: &ProjectionInteraction) -> i64 {
    let text_bytes = interaction.uri.len()
        + interaction.actor_did.len()
        + interaction.kind.as_str().len()
        + interaction.subject_uri.len()
        + interaction.boundary.len()
        + interaction.indexed_at.len()
        + interaction.retained_at.len();
    text_bytes as i64 + INTERACTION_ROW_OVERHEAD_BYTES
}

fn validate_interaction(interaction: &ProjectionInteraction) -> Result<(), StoreError> {
    crate::identifier::Did::parse(interaction.actor_did.clone())
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    let uri = crate::identifier::RecordUri::parse(&interaction.uri)
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    crate::identifier::RecordUri::parse(&interaction.subject_uri)
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    if interaction.subject_uri.len() > MAX_SUBJECT_URI_BYTES
        || uri.author().as_str() != interaction.actor_did
        || record_collection(&uri) != interaction.kind.collection()
        || interaction.boundary.is_empty()
        || !is_utc_timestamp(&interaction.indexed_at)
        || !is_utc_timestamp(&interaction.retained_at)
    {
        return Err(StoreError::InvalidProjectionMutation);
    }
    Ok(())
}

fn record_collection(uri: &crate::identifier::RecordUri) -> &str {
    match uri {
        crate::identifier::RecordUri::Repo { collection, .. }
        | crate::identifier::RecordUri::Space { collection, .. } => collection,
    }
}

impl EncryptedStore {
    pub fn list_interaction_boundaries_for_uris(
        &self,
        uris: &[String],
    ) -> Result<Vec<String>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT boundary FROM interaction WHERE uri = ?1")
            .map_err(StoreError::Open)?;
        let mut boundaries = Vec::new();
        for uri in uris {
            let rows = statement
                .query_map([uri], |row| row.get(0))
                .map_err(StoreError::Open)?;
            boundaries.extend(
                rows.collect::<Result<Vec<String>, _>>()
                    .map_err(StoreError::Open)?,
            );
        }
        Ok(boundaries)
    }
}

#[cfg(test)]
impl EncryptedStore {
    /// Rows as (uri, kind, subject_uri, boundary), for tests in other modules.
    pub(crate) fn interaction_rows(&self) -> Vec<(String, String, String, String)> {
        self.connection
            .prepare("SELECT uri, kind, subject_uri, boundary FROM interaction ORDER BY uri")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::moderation_label::{LabelPage, LabelSubject, ModerationLabel};

    const BEBOP: &str = "did:web:stratos.example/bebop";
    const RED_TAIL: &str = "did:web:stratos.example/red-tail";
    const SPIKE: &str = "did:plc:spikespiegel";
    const FAYE: &str = "did:plc:fayevalentine";
    const JET: &str = "did:plc:jetblack";
    const AUTHORITY: &str = "did:web:stratos.example";
    const AS_OF: &str = "1998-04-01T00:00:00.000Z";
    const MAXIMUM_RETAINED_AT: &str = "1998-06-01T00:00:00.000Z";
    const RETAINED_AT: &str = "1998-05-03T00:00:00.000Z";

    fn open_store() -> EncryptedStore {
        EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap()
    }

    fn post_uri(rkey: &str) -> String {
        format!("at://{SPIKE}/zone.stratos.feed.post/{rkey}")
    }

    fn like_uri(actor: &str, rkey: &str) -> String {
        format!("at://{actor}/app.bsky.feed.like/{rkey}")
    }

    fn post(rkey: &str, boundary: &str) -> ProjectionPost {
        ProjectionPost {
            uri: post_uri(rkey),
            author_did: SPIKE.to_owned(),
            cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            sort_at: "1998-04-03T00:00:00.000Z".to_owned(),
            indexed_at: "1998-04-03T00:00:01.000Z".to_owned(),
            retained_at: RETAINED_AT.to_owned(),
            record_json: br#"{"text":"Bang"}"#.to_vec(),
            blob_refs_json: b"[]".to_vec(),
            boundaries: vec![boundary.to_owned()],
        }
    }

    fn like(actor: &str, rkey: &str, subject: &str, boundary: &str) -> ProjectionInteraction {
        ProjectionInteraction {
            uri: like_uri(actor, rkey),
            actor_did: actor.to_owned(),
            kind: InteractionKind::Like,
            subject_uri: subject.to_owned(),
            boundary: boundary.to_owned(),
            indexed_at: "1998-04-03T00:00:01.000Z".to_owned(),
            retained_at: RETAINED_AT.to_owned(),
        }
    }

    fn page_of_posts(
        sequence: u64,
        upserts: Vec<ProjectionPost>,
        deletes: Vec<String>,
    ) -> ActorPage {
        ActorPage {
            authority_did: AUTHORITY.to_owned(),
            actor_did: SPIKE.to_owned(),
            sequence,
            upserts,
            deletes,
            updated_at: "1998-04-03T00:00:02.000Z".to_owned(),
            interactions: crate::store::InteractionChanges::default(),
        }
    }

    fn takedown_label(subject: LabelSubject) -> LabelPage {
        LabelPage {
            cursor: 1,
            labels: vec![ModerationLabel {
                seq: 1,
                subject,
                neg: false,
            }],
        }
    }

    impl EncryptedStore {
        fn in_transaction<T>(&mut self, work: impl FnOnce(&rusqlite::Transaction<'_>) -> T) -> T {
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            let outcome = work(&transaction);
            transaction.commit().unwrap();
            outcome
        }

        fn put_interaction(&mut self, interaction: &ProjectionInteraction) -> bool {
            self.in_transaction(|transaction| upsert_interaction(transaction, interaction).unwrap())
        }

        fn interaction_uris(&self) -> Vec<String> {
            self.connection
                .prepare("SELECT uri FROM interaction ORDER BY uri")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        }

        fn count(&self, table: &str) -> i64 {
            self.connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        }

        fn compact_to_capacity(&mut self, capacity: i64, limit: u16) -> ProjectionCompaction {
            // The stage budget reserves half of the cap, so doubling yields this capacity.
            self.compact_projection(AS_OF, MAXIMUM_RETAINED_AT, (capacity * 2) as u64, limit)
                .unwrap()
        }
    }

    fn assert_refused(interaction: &ProjectionInteraction, reason: &str) {
        let mut store = open_store();
        let outcome =
            store.in_transaction(|transaction| upsert_interaction(transaction, interaction));
        assert!(
            matches!(outcome, Err(StoreError::InvalidProjectionMutation)),
            "{reason}"
        );
        assert!(store.interaction_uris().is_empty(), "{reason}");
    }

    #[test]
    fn stores_an_interaction_and_removes_it_by_uri() {
        let mut store = open_store();
        let spike_like = like(FAYE, "swordfish", &post_uri("bang"), BEBOP);

        assert!(store.put_interaction(&spike_like));
        assert_eq!(
            store.interaction_uris(),
            std::slice::from_ref(&spike_like.uri)
        );
        let (actor, kind, subject, boundary): (String, String, String, String) = store
            .connection
            .query_row(
                "SELECT actor_did, kind, subject_uri, boundary FROM interaction",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (actor, kind, subject, boundary),
            (
                FAYE.to_owned(),
                "like".to_owned(),
                post_uri("bang"),
                BEBOP.to_owned()
            )
        );

        let removed = store.in_transaction(|transaction| {
            delete_interaction(transaction, &spike_like.uri).unwrap()
        });
        assert_eq!(removed, 1);
        assert!(store.interaction_uris().is_empty());
    }

    #[test]
    fn deleting_an_unknown_interaction_removes_nothing() {
        let mut store = open_store();
        store.put_interaction(&like(FAYE, "swordfish", &post_uri("bang"), BEBOP));

        let removed = store.in_transaction(|transaction| {
            delete_interaction(transaction, &like_uri(JET, "missing")).unwrap()
        });

        assert_eq!(removed, 0);
        assert_eq!(store.count("interaction"), 1);
    }

    #[test]
    fn a_repeated_upsert_replaces_the_row() {
        let mut store = open_store();
        let mut moved = like(FAYE, "swordfish", &post_uri("bang"), BEBOP);
        store.put_interaction(&moved);
        moved.boundary = RED_TAIL.to_owned();

        assert!(store.put_interaction(&moved));

        assert_eq!(store.count("interaction"), 1);
        let boundary: String = store
            .connection
            .query_row("SELECT boundary FROM interaction", [], |row| row.get(0))
            .unwrap();
        assert_eq!(boundary, RED_TAIL);
    }

    #[test]
    fn a_repost_is_stored_with_its_own_kind() {
        let mut store = open_store();
        let mut repost = like(FAYE, "swordfish", &post_uri("bang"), BEBOP);
        repost.kind = InteractionKind::Repost;
        repost.uri = format!("at://{FAYE}/app.bsky.feed.repost/swordfish");

        assert!(store.put_interaction(&repost));

        let kind: String = store
            .connection
            .query_row("SELECT kind FROM interaction", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kind, "repost");
    }

    #[test]
    fn malformed_interactions_are_refused_without_storing_anything() {
        let valid = like(FAYE, "swordfish", &post_uri("bang"), BEBOP);
        let cases: Vec<(&str, ProjectionInteraction)> = vec![
            (
                "actor is not a DID",
                ProjectionInteraction {
                    actor_did: "faye".to_owned(),
                    ..valid.clone()
                },
            ),
            (
                "uri is not a record uri",
                ProjectionInteraction {
                    uri: "https://example.test/like".to_owned(),
                    ..valid.clone()
                },
            ),
            (
                "uri belongs to another actor",
                ProjectionInteraction {
                    uri: like_uri(JET, "swordfish"),
                    ..valid.clone()
                },
            ),
            (
                "uri collection does not match the kind",
                ProjectionInteraction {
                    kind: InteractionKind::Repost,
                    ..valid.clone()
                },
            ),
            (
                "subject is not a record uri",
                ProjectionInteraction {
                    subject_uri: "not-a-uri".to_owned(),
                    ..valid.clone()
                },
            ),
            (
                "boundary is empty",
                ProjectionInteraction {
                    boundary: String::new(),
                    ..valid.clone()
                },
            ),
            (
                "indexed_at is not UTC",
                ProjectionInteraction {
                    indexed_at: "1998-04-03T00:00:01+09:00".to_owned(),
                    ..valid.clone()
                },
            ),
            (
                "retained_at is not UTC",
                ProjectionInteraction {
                    retained_at: "tomorrow".to_owned(),
                    ..valid.clone()
                },
            ),
        ];
        for (reason, interaction) in &cases {
            assert_refused(interaction, reason);
        }
    }

    fn subject_of_length(length: usize) -> String {
        let fixed = "at://did:plc:/zone.stratos.feed.post/bang".len();
        format!(
            "at://did:plc:{}/zone.stratos.feed.post/bang",
            "a".repeat(length - fixed)
        )
    }

    #[test]
    fn a_subject_longer_than_the_bound_is_refused_by_the_store() {
        let at_bound = subject_of_length(MAX_SUBJECT_URI_BYTES);
        let over_bound = subject_of_length(MAX_SUBJECT_URI_BYTES + 1);
        assert_eq!(at_bound.len(), MAX_SUBJECT_URI_BYTES);
        assert!(crate::identifier::RecordUri::parse(&over_bound).is_ok());

        let mut store = open_store();
        assert!(store.put_interaction(&like(FAYE, "one", &at_bound, BEBOP)));
        assert_refused(
            &like(FAYE, "two", &over_bound, BEBOP),
            "subject is over the bound",
        );
        let mut page = page_of_posts(1, Vec::new(), Vec::new());
        page.actor_did = FAYE.to_owned();
        page.interactions.upserts = vec![like(FAYE, "three", &over_bound, BEBOP)];
        assert!(matches!(
            store.apply_actor_page(page),
            Err(StoreError::InvalidProjectionMutation)
        ));
        assert_eq!(store.interaction_uris(), [like_uri(FAYE, "one")]);
    }

    #[test]
    fn deleting_a_post_through_an_actor_page_removes_only_its_interactions() {
        let mut store = open_store();
        store
            .apply_actor_page(page_of_posts(
                1,
                vec![post("bang", BEBOP), post("see-you", BEBOP)],
                Vec::new(),
            ))
            .unwrap();
        store.put_interaction(&like(FAYE, "one", &post_uri("bang"), BEBOP));
        store.put_interaction(&like(JET, "two", &post_uri("bang"), BEBOP));
        let untouched = like(FAYE, "three", &post_uri("see-you"), BEBOP);
        store.put_interaction(&untouched);

        store
            .apply_actor_page(page_of_posts(2, Vec::new(), vec![post_uri("bang")]))
            .unwrap();

        assert_eq!(store.interaction_uris(), [untouched.uri]);
    }

    #[test]
    fn purging_a_boundary_removes_the_interactions_of_posts_that_leave() {
        let mut store = open_store();
        store
            .apply_actor_page(page_of_posts(
                1,
                vec![post("bang", BEBOP), post("see-you", RED_TAIL)],
                Vec::new(),
            ))
            .unwrap();
        store.put_interaction(&like(FAYE, "one", &post_uri("bang"), BEBOP));
        let untouched = like(FAYE, "two", &post_uri("see-you"), RED_TAIL);
        store.put_interaction(&untouched);

        store.purge_boundary(BEBOP).unwrap();

        assert_eq!(store.interaction_uris(), [untouched.uri]);
    }

    #[test]
    fn an_expiring_post_takes_its_interactions_with_it() {
        let mut store = open_store();
        let mut expiring = post("bang", BEBOP);
        expiring.retained_at = "1998-04-02T00:00:00.000Z".to_owned();
        store
            .apply_actor_page(page_of_posts(
                1,
                vec![expiring, post("see-you", BEBOP)],
                Vec::new(),
            ))
            .unwrap();
        store.put_interaction(&like(FAYE, "one", &post_uri("bang"), BEBOP));
        let untouched = like(FAYE, "two", &post_uri("see-you"), BEBOP);
        store.put_interaction(&untouched);

        let compaction = store
            .compact_projection(
                "1998-04-03T00:00:00.000Z",
                MAXIMUM_RETAINED_AT,
                u64::MAX / 2,
                10,
            )
            .unwrap();

        assert_eq!(compaction.deleted, 1);
        assert_eq!(store.interaction_uris(), [untouched.uri]);
    }

    #[test]
    fn an_evicted_post_takes_its_interactions_with_it() {
        let mut store = open_store();
        let mut oldest = post("bang", BEBOP);
        oldest.sort_at = "1998-04-03T00:00:00.000Z".to_owned();
        let mut newest = post("see-you", BEBOP);
        newest.sort_at = "1998-04-04T00:00:00.000Z".to_owned();
        store
            .apply_actor_page(page_of_posts(1, vec![oldest, newest], Vec::new()))
            .unwrap();
        store.put_interaction(&like(FAYE, "one", &post_uri("bang"), BEBOP));
        let untouched = like(FAYE, "two", &post_uri("see-you"), BEBOP);
        store.put_interaction(&untouched);
        let newest_bytes: i64 = store
            .connection
            .query_row(
                "SELECT projection_bytes FROM post WHERE uri = ?1",
                [post_uri("see-you")],
                |row| row.get(0),
            )
            .unwrap();
        let untouched_bytes: i64 = store
            .connection
            .query_row(
                "SELECT projection_bytes FROM interaction WHERE uri = ?1",
                [&untouched.uri],
                |row| row.get(0),
            )
            .unwrap();

        let compaction = store.compact_to_capacity(newest_bytes + untouched_bytes, 1);

        assert_eq!(compaction.deleted, 1);
        assert!(!compaction.has_more);
        assert_eq!(store.count("post"), 1);
        assert_eq!(store.interaction_uris(), [untouched.uri]);
    }

    #[test]
    fn a_takedown_of_a_post_removes_its_interactions() {
        let mut store = open_store();
        store
            .apply_actor_page(page_of_posts(
                1,
                vec![post("bang", BEBOP), post("see-you", BEBOP)],
                Vec::new(),
            ))
            .unwrap();
        store.put_interaction(&like(FAYE, "one", &post_uri("bang"), BEBOP));
        let untouched = like(FAYE, "two", &post_uri("see-you"), BEBOP);
        store.put_interaction(&untouched);

        store
            .apply_label_page(
                AUTHORITY,
                &takedown_label(LabelSubject::Record {
                    uri: post_uri("bang"),
                    author_did: SPIKE.to_owned(),
                }),
                "1998-04-03T00:00:03.000Z",
            )
            .unwrap();

        assert_eq!(store.count("post"), 1);
        assert_eq!(store.interaction_uris(), [untouched.uri]);
    }

    #[test]
    fn unenrolling_an_author_removes_the_interactions_of_their_posts() {
        let mut store = open_store();
        store
            .apply_actor_page(page_of_posts(1, vec![post("bang", BEBOP)], Vec::new()))
            .unwrap();
        store.put_interaction(&like(FAYE, "one", &post_uri("bang"), BEBOP));
        let untouched = like(
            FAYE,
            "two",
            &format!("at://{JET}/zone.stratos.feed.post/ein"),
            BEBOP,
        );
        store.put_interaction(&untouched);

        store
            .reconcile_actor_enrollment(SPIKE, "1998-04-03T00:00:03.000Z", None)
            .unwrap();

        assert_eq!(store.count("post"), 0);
        assert_eq!(store.interaction_uris(), [untouched.uri]);
    }

    #[test]
    fn an_interaction_stored_before_its_post_survives_until_it_expires() {
        let mut store = open_store();
        let early = like(FAYE, "one", &post_uri("bang"), BEBOP);
        store.put_interaction(&early);
        assert_eq!(
            store.purge_expired("1998-04-04T00:00:00.000Z", 10).unwrap(),
            0
        );

        store
            .apply_actor_page(page_of_posts(1, vec![post("bang", BEBOP)], Vec::new()))
            .unwrap();
        assert_eq!(store.interaction_uris(), std::slice::from_ref(&early.uri));

        let mut doomed = early.clone();
        doomed.uri = like_uri(JET, "two");
        doomed.actor_did = JET.to_owned();
        doomed.retained_at = "1998-04-05T00:00:00.000Z".to_owned();
        store.put_interaction(&doomed);

        assert_eq!(
            store.purge_expired("1998-04-06T00:00:00.000Z", 10).unwrap(),
            1
        );
        assert_eq!(store.interaction_uris(), [early.uri]);
        assert_eq!(store.count("post"), 1);
    }

    #[test]
    fn compaction_expires_interactions_before_their_post() {
        let mut store = open_store();
        store
            .apply_actor_page(page_of_posts(1, vec![post("bang", BEBOP)], Vec::new()))
            .unwrap();
        let mut short_lived = like(FAYE, "one", &post_uri("bang"), BEBOP);
        short_lived.retained_at = "1998-04-02T00:00:00.000Z".to_owned();
        store.put_interaction(&short_lived);
        let kept = like(JET, "two", &post_uri("bang"), BEBOP);
        store.put_interaction(&kept);

        let compaction = store
            .compact_projection(
                "1998-04-03T00:00:00.000Z",
                MAXIMUM_RETAINED_AT,
                u64::MAX / 2,
                10,
            )
            .unwrap();

        assert_eq!(compaction.deleted, 1);
        assert!(!compaction.has_more);
        assert_eq!(store.interaction_uris(), [kept.uri]);
        assert_eq!(store.count("post"), 1);
    }

    const SHORTENED_AS_OF: &str = "1998-04-03T00:00:00.000Z";
    const SHORTENED_MAXIMUM_RETAINED_AT: &str = "1998-04-04T00:00:00.000Z";

    #[test]
    fn compaction_applies_a_shortened_retention_policy_to_existing_interactions() {
        let mut store = open_store();
        for rkey in ["one", "two"] {
            store.put_interaction(&like(FAYE, rkey, &post_uri("bang"), BEBOP));
        }

        let compaction = store
            .compact_projection(
                SHORTENED_AS_OF,
                SHORTENED_MAXIMUM_RETAINED_AT,
                u64::MAX / 2,
                10,
            )
            .unwrap();

        assert_eq!(compaction.deleted, 2);
        assert!(!compaction.has_more);
        assert!(store.interaction_uris().is_empty());
    }

    #[test]
    fn compaction_reports_interactions_left_past_a_shortened_maximum() {
        let mut store = open_store();
        for rkey in ["one", "two", "three"] {
            store.put_interaction(&like(FAYE, rkey, &post_uri("bang"), BEBOP));
        }

        let compaction = store
            .compact_projection(
                SHORTENED_AS_OF,
                SHORTENED_MAXIMUM_RETAINED_AT,
                u64::MAX / 2,
                2,
            )
            .unwrap();

        assert_eq!(compaction.deleted, 2);
        assert!(compaction.has_more);
        assert_eq!(store.count("interaction"), 1);
    }

    #[test]
    fn compaction_reports_remaining_expired_interactions() {
        let mut store = open_store();
        for rkey in ["one", "two", "three"] {
            let mut short_lived = like(FAYE, rkey, &post_uri("bang"), BEBOP);
            short_lived.retained_at = "1998-04-02T00:00:00.000Z".to_owned();
            store.put_interaction(&short_lived);
        }

        let compaction = store
            .compact_projection(
                "1998-04-03T00:00:00.000Z",
                MAXIMUM_RETAINED_AT,
                u64::MAX / 2,
                2,
            )
            .unwrap();

        assert_eq!(compaction.deleted, 2);
        assert!(compaction.has_more);
    }

    #[test]
    fn compaction_evicts_orphan_interactions_before_any_post() {
        let mut store = open_store();
        store
            .apply_actor_page(page_of_posts(
                1,
                vec![post("bang", BEBOP), post("see-you", BEBOP)],
                Vec::new(),
            ))
            .unwrap();
        let posts_bytes: i64 = store
            .connection
            .query_row("SELECT SUM(projection_bytes) FROM post", [], |row| {
                row.get(0)
            })
            .unwrap();
        for rkey in ["a", "b", "c", "d", "e", "f"] {
            store.put_interaction(&like(
                FAYE,
                rkey,
                &format!("at://{JET}/zone.stratos.feed.post/ein-{rkey}"),
                BEBOP,
            ));
        }

        assert_eq!(store.count("interaction"), 6);

        loop {
            let compaction = store.compact_to_capacity(posts_bytes, 2);
            assert_eq!(
                store.count("post"),
                2,
                "a post was evicted before the orphans"
            );
            if !compaction.has_more {
                break;
            }
        }

        assert_eq!(store.count("interaction"), 0);
        let published = store.in_transaction(|transaction| published_bytes(transaction).unwrap());
        assert!(published <= posts_bytes);
    }

    #[test]
    fn compaction_evicts_posts_only_once_no_orphan_is_left() {
        let mut store = open_store();
        let mut oldest = post("bang", BEBOP);
        oldest.sort_at = "1998-04-03T00:00:00.000Z".to_owned();
        let mut newest = post("see-you", BEBOP);
        newest.sort_at = "1998-04-04T00:00:00.000Z".to_owned();
        store
            .apply_actor_page(page_of_posts(1, vec![oldest, newest], Vec::new()))
            .unwrap();
        store.put_interaction(&like(
            FAYE,
            "orphan",
            &format!("at://{JET}/zone.stratos.feed.post/ein"),
            BEBOP,
        ));
        let newest_bytes: i64 = store
            .connection
            .query_row(
                "SELECT projection_bytes FROM post WHERE uri = ?1",
                [post_uri("see-you")],
                |row| row.get(0),
            )
            .unwrap();

        let first = store.compact_to_capacity(newest_bytes, 1);
        assert_eq!(store.count("interaction"), 0);
        assert_eq!(store.count("post"), 2);
        assert!(first.has_more);

        let second = store.compact_to_capacity(newest_bytes, 1);
        assert!(!second.has_more);
        assert_eq!(
            store
                .connection
                .query_row("SELECT uri FROM post", [], |row| row.get::<_, String>(0))
                .unwrap(),
            post_uri("see-you")
        );
    }

    #[test]
    fn an_orphan_is_an_interaction_without_a_post_in_its_own_boundary() {
        let mut store = open_store();
        store
            .apply_actor_page(page_of_posts(
                1,
                vec![post("bang", BEBOP), post("see-you", RED_TAIL)],
                Vec::new(),
            ))
            .unwrap();
        let kept = like(FAYE, "kept", &post_uri("bang"), BEBOP);
        store.put_interaction(&kept);
        store.put_interaction(&like(FAYE, "other-boundary", &post_uri("see-you"), BEBOP));
        store.put_interaction(&like(
            FAYE,
            "no-post",
            &format!("at://{JET}/zone.stratos.feed.post/ein"),
            BEBOP,
        ));

        let evicted =
            store.in_transaction(|transaction| evict_orphan_interactions(transaction, 10).unwrap());

        assert_eq!(evicted, 2);
        assert_eq!(store.interaction_uris(), [kept.uri]);
    }

    #[test]
    fn orphans_are_evicted_oldest_first_and_within_the_limit() {
        let mut store = open_store();
        for (rkey, retained_at) in [
            ("newest", "1998-05-05T00:00:00.000Z"),
            ("oldest", "1998-05-03T00:00:00.000Z"),
            ("middle", "1998-05-04T00:00:00.000Z"),
        ] {
            let mut orphan = like(FAYE, rkey, &post_uri("missing"), BEBOP);
            orphan.retained_at = retained_at.to_owned();
            store.put_interaction(&orphan);
        }

        let evicted =
            store.in_transaction(|transaction| evict_orphan_interactions(transaction, 1).unwrap());

        assert_eq!(evicted, 1);
        assert_eq!(
            store.interaction_uris(),
            [like_uri(FAYE, "middle"), like_uri(FAYE, "newest")]
        );
    }

    #[test]
    fn published_bytes_counts_posts_and_interactions() {
        let mut store = open_store();
        store
            .apply_actor_page(page_of_posts(1, vec![post("bang", BEBOP)], Vec::new()))
            .unwrap();
        let spike_like = like(FAYE, "one", &post_uri("bang"), BEBOP);
        store.put_interaction(&spike_like);
        let post_bytes: i64 = store
            .connection
            .query_row("SELECT SUM(projection_bytes) FROM post", [], |row| {
                row.get(0)
            })
            .unwrap();
        let stored_interaction_bytes: i64 = store
            .connection
            .query_row("SELECT SUM(projection_bytes) FROM interaction", [], |row| {
                row.get(0)
            })
            .unwrap();
        let text_bytes = spike_like.uri.len()
            + spike_like.actor_did.len()
            + spike_like.kind.as_str().len()
            + spike_like.subject_uri.len()
            + spike_like.boundary.len()
            + spike_like.indexed_at.len()
            + spike_like.retained_at.len();

        assert_eq!(
            stored_interaction_bytes,
            text_bytes as i64 + INTERACTION_ROW_OVERHEAD_BYTES
        );
        let published = store.in_transaction(|transaction| published_bytes(transaction).unwrap());
        assert_eq!(published, post_bytes + stored_interaction_bytes);
    }

    #[test]
    fn a_taken_down_interaction_is_not_admitted() {
        let mut store = open_store();
        let taken_down = like(FAYE, "swordfish", &post_uri("bang"), BEBOP);
        store
            .apply_label_page(
                AUTHORITY,
                &takedown_label(LabelSubject::Record {
                    uri: taken_down.uri.clone(),
                    author_did: FAYE.to_owned(),
                }),
                "1998-04-03T00:00:03.000Z",
            )
            .unwrap();

        assert!(!store.put_interaction(&taken_down));
        assert!(store.interaction_uris().is_empty());
        assert!(store.put_interaction(&like(FAYE, "other", &post_uri("bang"), BEBOP)));
    }

    #[test]
    fn removal_helpers_are_scoped_to_their_actor_and_boundary() {
        let mut store = open_store();
        let subject = post_uri("bang");
        store.put_interaction(&like(FAYE, "a", &subject, BEBOP));
        store.put_interaction(&like(FAYE, "b", &subject, RED_TAIL));
        store.put_interaction(&like(JET, "c", &subject, BEBOP));

        let removed = store.in_transaction(|transaction| {
            delete_actor_boundary_interactions(transaction, FAYE, BEBOP).unwrap()
        });
        assert_eq!(removed, 1);
        assert_eq!(
            store.interaction_uris(),
            [like_uri(FAYE, "b"), like_uri(JET, "c")]
        );

        let removed = store.in_transaction(|transaction| {
            delete_boundary_interactions(transaction, BEBOP).unwrap()
        });
        assert_eq!(removed, 1);
        assert_eq!(store.interaction_uris(), [like_uri(FAYE, "b")]);

        let removed = store
            .in_transaction(|transaction| delete_actor_interactions(transaction, FAYE).unwrap());
        assert_eq!(removed, 1);
        assert!(store.interaction_uris().is_empty());
    }

    #[test]
    fn an_actor_page_applies_its_interactions_with_the_posts_and_the_cursor() {
        let mut store = open_store();
        let stale = like(SPIKE, "stale", &post_uri("bang"), BEBOP);
        store.put_interaction(&stale);
        let mut page = page_of_posts(4, vec![post("bang", BEBOP)], Vec::new());
        let fresh = like(SPIKE, "fresh", &post_uri("bang"), BEBOP);
        page.interactions = InteractionChanges {
            upserts: vec![fresh.clone()],
            deletes: vec![stale.uri],
        };

        store.apply_actor_page(page).unwrap();

        assert_eq!(store.interaction_uris(), [fresh.uri]);
        assert_eq!(store.count("post"), 1);
        let sequence: i64 = store
            .connection
            .query_row("SELECT sequence FROM actor_cursor", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sequence, 4);
    }

    #[test]
    fn an_actor_page_with_an_invalid_interaction_applies_nothing() {
        let invalid = [
            like(FAYE, "someone-else", &post_uri("bang"), BEBOP),
            like(SPIKE, "no-boundary", &post_uri("bang"), ""),
        ];
        for interaction in invalid {
            let mut store = open_store();
            let mut page = page_of_posts(4, vec![post("bang", BEBOP)], Vec::new());
            page.interactions.upserts = vec![interaction];

            assert!(matches!(
                store.apply_actor_page(page),
                Err(StoreError::InvalidProjectionMutation)
            ));
            assert_eq!(store.count("post"), 0);
            assert_eq!(store.count("actor_cursor"), 0);
        }
    }

    #[test]
    fn an_actor_page_may_only_delete_the_likes_and_reposts_of_its_own_actor() {
        let foreign = like_uri(FAYE, "swordfish");
        let own_post = post_uri("bang");
        for uri in [foreign, own_post] {
            let mut store = open_store();
            let mut page = page_of_posts(4, Vec::new(), Vec::new());
            page.interactions.deletes = vec![uri];

            assert!(matches!(
                store.apply_actor_page(page),
                Err(StoreError::InvalidProjectionMutation)
            ));
        }
    }

    const PDS_SPACE: &str = "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop";

    fn repost(actor: &str, rkey: &str, subject: &str, boundary: &str) -> ProjectionInteraction {
        ProjectionInteraction {
            uri: format!("at://{actor}/app.bsky.feed.repost/{rkey}"),
            kind: InteractionKind::Repost,
            ..like(actor, rkey, subject, boundary)
        }
    }

    fn enrollment(did: &str, boundaries: &[&str], observed_at: &str) -> ActorEnrollment {
        ActorEnrollment {
            did: did.to_owned(),
            boundaries: boundaries
                .iter()
                .map(|boundary| (*boundary).to_owned())
                .collect(),
            observed_at: observed_at.to_owned(),
        }
    }

    fn enroll(store: &mut EncryptedStore, did: &str, boundaries: &[&str], observed_at: &str) {
        store
            .reconcile_actor_enrollment(
                did,
                observed_at,
                Some(enrollment(did, boundaries, observed_at)),
            )
            .unwrap();
    }

    #[test]
    fn an_actors_own_delete_removes_their_like_and_their_repost() {
        let mut store = open_store();
        let subject = post_uri("bang");
        let spike_like = like(SPIKE, "one", &subject, BEBOP);
        let spike_repost = repost(SPIKE, "two", &subject, BEBOP);
        store.put_interaction(&spike_like);
        store.put_interaction(&spike_repost);
        let untouched = like(FAYE, "three", &subject, BEBOP);
        store.put_interaction(&untouched);
        let mut page = page_of_posts(1, Vec::new(), Vec::new());
        page.interactions.deletes = vec![spike_like.uri, spike_repost.uri];

        store.apply_actor_page(page).unwrap();

        assert_eq!(store.interaction_uris(), [untouched.uri]);
    }

    #[test]
    fn an_actor_leaving_a_boundary_removes_their_interactions_there() {
        let mut store = open_store();
        enroll(
            &mut store,
            FAYE,
            &[BEBOP, RED_TAIL],
            "1998-04-03T00:00:00.000Z",
        );
        let subject = post_uri("bang");
        store.put_interaction(&like(FAYE, "left", &subject, BEBOP));
        store.put_interaction(&repost(FAYE, "left-too", &subject, BEBOP));
        let kept_elsewhere = like(FAYE, "kept", &subject, RED_TAIL);
        store.put_interaction(&kept_elsewhere);
        let someone_else = like(JET, "other", &subject, BEBOP);
        store.put_interaction(&someone_else);

        let reconciliation = store
            .reconcile_actor_enrollment(
                FAYE,
                "1998-04-03T00:00:01.000Z",
                Some(enrollment(FAYE, &[RED_TAIL], "1998-04-03T00:00:01.000Z")),
            )
            .unwrap();

        assert_eq!(reconciliation.removed_boundaries, [BEBOP]);
        assert_eq!(
            store.interaction_uris(),
            [someone_else.uri.clone(), kept_elsewhere.uri.clone()]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn an_actor_unenrolling_removes_every_interaction_they_made() {
        let mut store = open_store();
        enroll(
            &mut store,
            FAYE,
            &[BEBOP, RED_TAIL],
            "1998-04-03T00:00:00.000Z",
        );
        let subject = post_uri("bang");
        store.put_interaction(&like(FAYE, "one", &subject, BEBOP));
        store.put_interaction(&repost(FAYE, "two", &subject, RED_TAIL));
        let someone_else = like(JET, "other", &subject, BEBOP);
        store.put_interaction(&someone_else);

        store
            .reconcile_actor_enrollment(FAYE, "1998-04-03T00:00:01.000Z", None)
            .unwrap();

        assert_eq!(store.interaction_uris(), [someone_else.uri]);
    }

    #[test]
    fn an_account_takedown_removes_every_interaction_the_account_made() {
        let mut store = open_store();
        enroll(&mut store, FAYE, &[BEBOP], "1998-04-03T00:00:00.000Z");
        let subject = post_uri("bang");
        store.put_interaction(&like(FAYE, "one", &subject, BEBOP));
        store.put_interaction(&repost(FAYE, "two", &subject, BEBOP));
        let someone_else = like(JET, "other", &subject, BEBOP);
        store.put_interaction(&someone_else);

        let effects = store
            .apply_label_page(
                AUTHORITY,
                &takedown_label(LabelSubject::Account {
                    did: FAYE.to_owned(),
                }),
                "1998-04-03T00:00:03.000Z",
            )
            .unwrap();

        assert_eq!(effects.unenrolled_boundaries, [BEBOP]);
        assert_eq!(
            store.interaction_uris(),
            std::slice::from_ref(&someone_else.uri)
        );
    }

    #[test]
    fn pds_member_removal_removes_the_members_interactions_in_that_boundary() {
        use crate::space_sync::{
            SpacePage, SpaceRepoOp, SpaceSyncTarget, prepare_space_page, stage_space_page,
        };

        let mut store = open_store();
        let member = |did: &str| PdsSpaceMember {
            did: did.to_owned(),
        };
        store
            .replace_pds_space_members(BEBOP, vec![member(FAYE), member(JET)], AS_OF)
            .unwrap();
        let subject = format!("{PDS_SPACE}/{SPIKE}/zone.stratos.feed.post/bang");
        for (actor, rkey) in [(FAYE, "one"), (JET, "two")] {
            let target =
                SpaceSyncTarget::from_authoritative_membership(&store, PDS_SPACE, BEBOP, actor)
                    .unwrap();
            let prepared = prepare_space_page(
                target,
                SpacePage {
                    ops: vec![SpaceRepoOp {
                        collection: InteractionKind::Like.collection().to_owned(),
                        rkey: rkey.to_owned(),
                        cid: Some(
                            "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                                .to_owned(),
                        ),
                        value: Some(serde_json::json!({
                            "$type": InteractionKind::Like.collection(),
                            "subject": { "uri": subject }
                        })),
                    }],
                    next_cursor: None,
                },
                AS_OF,
            )
            .unwrap();
            stage_space_page(&mut store, prepared).unwrap();
            store
                .promote_authorized_space_stage(BEBOP, PDS_SPACE, actor, RETAINED_AT)
                .unwrap();
        }
        let elsewhere = like(FAYE, "elsewhere", &subject, RED_TAIL);
        store.put_interaction(&elsewhere);
        assert_eq!(store.count("interaction"), 3);

        store
            .replace_pds_space_members(BEBOP, vec![member(JET)], AS_OF)
            .unwrap();

        assert_eq!(
            store.interaction_uris(),
            [
                format!("{PDS_SPACE}/{JET}/app.bsky.feed.like/two"),
                elsewhere.uri
            ]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_boundary_purge_removes_the_interactions_stored_under_it() {
        let mut store = open_store();
        store
            .apply_actor_page(page_of_posts(
                1,
                vec![post("see-you", RED_TAIL)],
                Vec::new(),
            ))
            .unwrap();
        store.put_interaction(&like(FAYE, "no-post-yet", &post_uri("bang"), BEBOP));
        store.put_interaction(&repost(JET, "also-early", &post_uri("bang"), BEBOP));
        let kept = like(FAYE, "kept", &post_uri("see-you"), RED_TAIL);
        store.put_interaction(&kept);

        store.purge_boundary(BEBOP).unwrap();

        assert_eq!(store.interaction_uris(), [kept.uri]);
    }

    #[test]
    fn a_takedown_label_on_a_like_removes_it_and_refuses_readmission() {
        let mut store = open_store();
        let subject = post_uri("bang");
        let doomed = like(SPIKE, "swordfish", &subject, BEBOP);
        let kept = like(SPIKE, "other", &subject, BEBOP);
        store.put_interaction(&doomed);
        store.put_interaction(&kept);

        let effects = store
            .apply_label_page(
                AUTHORITY,
                &takedown_label(LabelSubject::Record {
                    uri: doomed.uri.clone(),
                    author_did: SPIKE.to_owned(),
                }),
                "1998-04-03T00:00:03.000Z",
            )
            .unwrap();

        assert_eq!(effects.removed_record_boundaries, [BEBOP]);
        assert_eq!(store.interaction_uris(), std::slice::from_ref(&kept.uri));
        let mut replay = page_of_posts(2, Vec::new(), Vec::new());
        replay.interactions.upserts = vec![doomed.clone()];
        store.apply_actor_page(replay).unwrap();
        assert_eq!(store.interaction_uris(), [kept.uri]);
        assert!(!store.put_interaction(&doomed));
    }

    #[test]
    fn a_purge_between_prepare_and_release_refuses_a_page_with_interactions() {
        use crate::service::{ProjectionReader, ReadRequest};

        let mut reader = ProjectionReader::new(open_store());
        let mut page = page_of_posts(1, vec![post("bang", BEBOP)], Vec::new());
        page.interactions.upserts = vec![
            like(SPIKE, "on-the-post", &post_uri("bang"), BEBOP),
            like(SPIKE, "before-its-post", &post_uri("later"), BEBOP),
        ];
        reader.apply_actor_page(page).unwrap();
        reader.establish_session();
        let request = ReadRequest {
            viewer: FAYE,
            boundary: BEBOP,
            authority_expires_at: 100,
            now: 1,
            cursor: None,
            limit: 50,
            as_of: AS_OF,
        };
        let (token, feed_page) = reader.prepare(request).unwrap().unwrap();

        reader.revoke_boundary(BEBOP).unwrap();

        assert!(reader.release(token, feed_page, 2).is_none());
        assert!(reader.interaction_rows().is_empty());
    }
}

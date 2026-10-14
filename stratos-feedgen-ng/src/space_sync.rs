use std::collections::BTreeMap;

use cid::Cid;
use serde_json::Value;

use crate::{
    identifier::{Did, RecordUri},
    store::{EncryptedStore, SpaceStageMutation, SpaceStagePage, StoreError, is_utc_timestamp},
};

pub const POST_COLLECTION: &str = "zone.stratos.feed.post";
pub const MAX_SPACE_PAGE_OPS: usize = 1_000;
pub const MAX_SPACE_RECORD_BYTES: usize = 64 * 1024;
const MAX_CURSOR_BYTES: usize = 4 * 1024;
const MAX_COLLECTION_BYTES: usize = 317;
const MAX_RKEY_BYTES: usize = 512;
const MAX_CID_BYTES: usize = 256;
const MAX_SPACE_URI_BYTES: usize = 2_048;
const MAX_DID_BYTES: usize = 2_048;

/// A member is syncable only when an authority-derived membership pass supplies
/// this target. Records themselves never choose the boundary used for staging.
pub struct SpaceSyncTarget {
    space_uri: String,
    boundary: String,
    actor_did: String,
    generation: u64,
}

impl SpaceSyncTarget {
    pub fn from_authoritative_membership(
        store: &EncryptedStore,
        space_uri: impl Into<String>,
        boundary: impl Into<String>,
        actor_did: impl Into<String>,
    ) -> Result<Self, SpaceSyncError> {
        let boundary = boundary.into();
        let actor_did = actor_did.into();
        let generation = store
            .pds_member_generation(&boundary, &actor_did)
            .map_err(SpaceSyncError::Store)?
            .ok_or(SpaceSyncError::UnauthorizedTarget)?;
        Self::from_authoritative_membership_at_generation(
            store, space_uri, boundary, actor_did, generation,
        )
    }

    pub fn from_authoritative_membership_at_generation(
        store: &EncryptedStore,
        space_uri: impl Into<String>,
        boundary: impl Into<String>,
        actor_did: impl Into<String>,
        generation: u64,
    ) -> Result<Self, SpaceSyncError> {
        let target = Self {
            space_uri: space_uri.into(),
            boundary: boundary.into(),
            actor_did: actor_did.into(),
            generation,
        };
        validate_target(&target)?;
        if store
            .pds_member_generation(&target.boundary, &target.actor_did)
            .map_err(SpaceSyncError::Store)?
            != Some(generation)
        {
            return Err(SpaceSyncError::UnauthorizedTarget);
        }
        Ok(target)
    }
}

pub struct SpaceRepoOp {
    pub collection: String,
    pub rkey: String,
    pub cid: Option<String>,
    pub value: Option<Value>,
}

pub struct SpacePage {
    pub ops: Vec<SpaceRepoOp>,
    pub next_cursor: Option<String>,
}

pub struct PreparedSpacePage {
    target: SpaceSyncTarget,
    page: SpaceStagePage,
    mutations: Vec<SpaceStageMutation>,
    pub indexed: u16,
    pub deleted: u16,
    pub skipped: u16,
}

#[derive(Debug)]
pub enum SpaceSyncError {
    InvalidTarget,
    UnauthorizedTarget,
    InvalidPage,
    InvalidTimestamp,
    Store(StoreError),
}

impl std::fmt::Display for SpaceSyncError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidTarget => formatter.write_str("space sync target is invalid"),
            Self::UnauthorizedTarget => formatter.write_str("space sync target is unauthorized"),
            Self::InvalidPage => formatter.write_str("space sync page is invalid"),
            Self::InvalidTimestamp => formatter.write_str("space sync timestamp is invalid"),
            Self::Store(error) => write!(formatter, "space sync store operation failed: {error}"),
        }
    }
}

impl std::error::Error for SpaceSyncError {}

/// Validates and stages only inline post values from one bounded PDS page.
/// A terminal page remains unqueryable because promotion requires independent
/// commit verification in the caller.
pub fn prepare_space_page(
    target: SpaceSyncTarget,
    page: SpacePage,
    updated_at: &str,
) -> Result<PreparedSpacePage, SpaceSyncError> {
    validate_target(&target)?;
    if !is_utc_timestamp(updated_at) {
        return Err(SpaceSyncError::InvalidTimestamp);
    }
    if page.ops.len() > MAX_SPACE_PAGE_OPS
        || page
            .next_cursor
            .as_deref()
            .is_some_and(|cursor| cursor.is_empty() || cursor.len() > MAX_CURSOR_BYTES)
    {
        return Err(SpaceSyncError::InvalidPage);
    }

    let mut latest = BTreeMap::new();
    let mut skipped = 0;
    for op in page.ops {
        if op.collection.len() > MAX_COLLECTION_BYTES
            || op.rkey.len() > MAX_RKEY_BYTES
            || op.cid.as_ref().is_some_and(|cid| cid.len() > MAX_CID_BYTES)
        {
            skipped += 1;
            continue;
        }
        if op.collection != POST_COLLECTION {
            continue;
        }
        if op.cid.is_some()
            && op
                .value
                .as_ref()
                .is_some_and(|value| !is_post_record(value))
        {
            skipped += 1;
            continue;
        }
        latest.insert((op.collection.clone(), op.rkey.clone()), op);
    }

    let mut mutations = Vec::new();
    let mut indexed = 0;
    let mut deleted = 0;
    for (_, op) in latest {
        let uri = format!(
            "{}/{}/{}/{}",
            target.space_uri, target.actor_did, op.collection, op.rkey
        );
        if !matches!(
            RecordUri::parse_space_record(&uri),
            Ok(RecordUri::Space { .. })
        ) {
            skipped += 1;
            continue;
        }
        let Some(cid) = op.cid else {
            mutations.push(SpaceStageMutation::Delete { uri });
            deleted += 1;
            continue;
        };
        let Some(value) = op.value else {
            skipped += 1;
            continue;
        };
        let Ok(cid) = Cid::try_from(cid.as_str()) else {
            skipped += 1;
            continue;
        };
        let Ok(record_json) = serialize_bounded(&value) else {
            skipped += 1;
            continue;
        };
        let sort_at = value
            .as_object()
            .and_then(|record| record.get("createdAt"))
            .and_then(Value::as_str)
            .filter(|value| is_utc_timestamp(value) && *value <= updated_at)
            .unwrap_or(updated_at)
            .to_owned();
        mutations.push(SpaceStageMutation::Upsert {
            uri,
            cid: cid.to_string(),
            sort_at,
            indexed_at: updated_at.to_owned(),
            record_json,
            blob_refs_json: b"[]".to_vec(),
        });
        indexed += 1;
    }
    let page = SpaceStagePage {
        space_uri: target.space_uri.clone(),
        actor_did: target.actor_did.clone(),
        boundary: target.boundary.clone(),
        next_cursor: page.next_cursor,
        updated_at: updated_at.to_owned(),
    };
    Ok(PreparedSpacePage {
        target,
        page,
        mutations,
        indexed,
        deleted,
        skipped,
    })
}

pub fn stage_space_page(
    store: &mut EncryptedStore,
    prepared: PreparedSpacePage,
) -> Result<(), SpaceSyncError> {
    if prepared.page.space_uri != prepared.target.space_uri
        || prepared.page.boundary != prepared.target.boundary
        || prepared.page.actor_did != prepared.target.actor_did
    {
        return Err(SpaceSyncError::InvalidTarget);
    }
    store
        .stage_authorized_space_page_at_generation(
            prepared.page,
            prepared.mutations,
            prepared.target.generation,
        )
        .map_err(|error| match error {
            StoreError::UnauthorizedSpaceMember => SpaceSyncError::UnauthorizedTarget,
            error => SpaceSyncError::Store(error),
        })
}

fn validate_target(target: &SpaceSyncTarget) -> Result<(), SpaceSyncError> {
    if target.space_uri.len() > MAX_SPACE_URI_BYTES
        || target.boundary.is_empty()
        || target.boundary.len() > 256
        || !target.boundary.is_ascii()
        || target.actor_did.len() > MAX_DID_BYTES
        || Did::parse(target.actor_did.to_owned()).is_err()
    {
        return Err(SpaceSyncError::InvalidTarget);
    }
    let probe = format!(
        "{}/{}/{}/probe",
        target.space_uri, target.actor_did, POST_COLLECTION
    );
    let Some((boundary_authority, boundary_key)) = target.boundary.split_once('/') else {
        return Err(SpaceSyncError::InvalidTarget);
    };
    match RecordUri::parse_space_record(&probe) {
        Ok(RecordUri::Space {
            authority,
            space_type,
            space_key,
            author,
            ..
        }) if authority.as_str() == boundary_authority
            && space_type == "zone.stratos.space.feed"
            && space_key == boundary_key
            && author.as_str() == target.actor_did =>
        {
            Ok(())
        }
        _ => Err(SpaceSyncError::InvalidTarget),
    }
}

fn is_post_record(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|record| record.get("$type"))
        .and_then(Value::as_str)
        == Some(POST_COLLECTION)
}

fn serialize_bounded(value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    struct LimitedBuffer {
        bytes: Vec<u8>,
    }

    impl std::io::Write for LimitedBuffer {
        fn write(&mut self, value: &[u8]) -> std::io::Result<usize> {
            if self.bytes.len().saturating_add(value.len()) > MAX_SPACE_RECORD_BYTES {
                return Err(std::io::Error::other("record exceeds configured limit"));
            }
            self.bytes.extend_from_slice(value);
            Ok(value.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut buffer = LimitedBuffer { bytes: Vec::new() };
    serde_json::to_writer(&mut buffer, value)?;
    Ok(buffer.bytes)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        POST_COLLECTION, SpacePage, SpaceRepoOp, SpaceSyncTarget, prepare_space_page,
        stage_space_page,
    };
    use crate::store::{EncryptedStore, PdsSpaceMember, StorageKey};

    const SPACE: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop";
    const ACTOR: &str = "did:plc:fayevalentine";
    const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const NOW: &str = "2026-09-22T00:00:00.000Z";
    const CID: &str = "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn authorized_store() -> EncryptedStore {
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .replace_pds_space_members(
                BOUNDARY,
                vec![PdsSpaceMember {
                    did: ACTOR.to_owned(),
                }],
                NOW,
            )
            .unwrap();
        store
    }

    fn target(store: &EncryptedStore) -> SpaceSyncTarget {
        SpaceSyncTarget::from_authoritative_membership(store, SPACE, BOUNDARY, ACTOR).unwrap()
    }

    #[test]
    fn stamps_authority_boundary_instead_of_pds_record_boundary() {
        let store = authorized_store();
        let prepared = prepare_space_page(
            target(&store),
            SpacePage {
                ops: vec![SpaceRepoOp {
                    collection: POST_COLLECTION.to_owned(),
                    rkey: "see-you".to_owned(),
                    cid: Some(CID.to_owned()),
                    value: Some(json!({
                        "$type": POST_COLLECTION,
                        "createdAt": "2026-09-21T00:00:00.000Z",
                        "boundary": { "values": ["forged"] }
                    })),
                }],
                next_cursor: None,
            },
            NOW,
        )
        .unwrap();

        assert_eq!(prepared.page.boundary, BOUNDARY);
        assert_eq!(prepared.indexed, 1);
        assert_eq!(prepared.deleted, 0);
        assert_eq!(prepared.skipped, 0);
        assert!(matches!(
            prepared.mutations.as_slice(),
            [super::SpaceStageMutation::Upsert { uri, sort_at, .. }]
                if uri == &format!("{SPACE}/{ACTOR}/{POST_COLLECTION}/see-you")
                    && sort_at == "2026-09-21T00:00:00.000Z"
        ));
    }

    #[test]
    fn keeps_the_last_mutation_for_each_record_and_clamps_future_dates() {
        let store = authorized_store();
        let prepared = prepare_space_page(
            target(&store),
            SpacePage {
                ops: vec![
                    SpaceRepoOp {
                        collection: POST_COLLECTION.to_owned(),
                        rkey: "see-you".to_owned(),
                        cid: None,
                        value: None,
                    },
                    SpaceRepoOp {
                        collection: POST_COLLECTION.to_owned(),
                        rkey: "see-you".to_owned(),
                        cid: Some(CID.to_owned()),
                        value: Some(json!({
                            "$type": POST_COLLECTION,
                            "createdAt": "2026-10-01T00:00:00.000Z"
                        })),
                    },
                ],
                next_cursor: Some("page-2".to_owned()),
            },
            NOW,
        )
        .unwrap();

        assert_eq!(prepared.indexed, 1);
        assert_eq!(prepared.deleted, 0);
        assert!(matches!(
            prepared.mutations.as_slice(),
            [super::SpaceStageMutation::Upsert { sort_at, .. }] if sort_at == NOW
        ));
    }

    #[test]
    fn skips_untrusted_or_incomplete_post_values() {
        let store = authorized_store();
        let prepared = prepare_space_page(
            target(&store),
            SpacePage {
                ops: vec![
                    SpaceRepoOp {
                        collection: POST_COLLECTION.to_owned(),
                        rkey: "missing".to_owned(),
                        cid: Some(CID.to_owned()),
                        value: None,
                    },
                    SpaceRepoOp {
                        collection: POST_COLLECTION.to_owned(),
                        rkey: "wrong-type".to_owned(),
                        cid: Some(CID.to_owned()),
                        value: Some(json!({ "$type": "app.bsky.feed.post" })),
                    },
                    SpaceRepoOp {
                        collection: "app.bsky.feed.post".to_owned(),
                        rkey: "ignored".to_owned(),
                        cid: Some(CID.to_owned()),
                        value: Some(json!({ "$type": "app.bsky.feed.post" })),
                    },
                ],
                next_cursor: None,
            },
            NOW,
        )
        .unwrap();

        assert!(prepared.mutations.is_empty());
        assert_eq!(prepared.skipped, 2);
    }

    #[test]
    fn keeps_a_terminal_space_page_hidden_until_it_is_verified() {
        let mut store = authorized_store();
        let prepared = prepare_space_page(
            target(&store),
            SpacePage {
                ops: vec![SpaceRepoOp {
                    collection: POST_COLLECTION.to_owned(),
                    rkey: "see-you".to_owned(),
                    cid: Some(CID.to_owned()),
                    value: Some(json!({ "$type": POST_COLLECTION })),
                }],
                next_cursor: None,
            },
            NOW,
        )
        .unwrap();
        stage_space_page(&mut store, prepared).unwrap();

        assert!(
            store
                .list_posts_by_boundary(BOUNDARY, None, 50, NOW)
                .unwrap()
                .posts
                .is_empty()
        );
        store
            .promote_authorized_space_stage(BOUNDARY, SPACE, ACTOR, "2026-09-23T00:00:00.000Z")
            .unwrap();
        assert_eq!(
            store
                .list_posts_by_boundary(BOUNDARY, None, 50, NOW)
                .unwrap()
                .posts
                .len(),
            1
        );
    }

    #[test]
    fn rejects_targets_without_current_authoritative_membership() {
        let store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        assert!(
            SpaceSyncTarget::from_authoritative_membership(&store, SPACE, BOUNDARY, ACTOR).is_err()
        );
    }

    #[test]
    fn rejects_a_prepared_page_after_membership_is_revoked() {
        let mut store = authorized_store();
        let prepared = prepare_space_page(
            target(&store),
            SpacePage {
                ops: vec![],
                next_cursor: Some("page-2".to_owned()),
            },
            NOW,
        )
        .unwrap();
        store
            .replace_pds_space_members(BOUNDARY, vec![], "2026-09-22T00:01:00.000Z")
            .unwrap();

        assert!(matches!(
            stage_space_page(&mut store, prepared),
            Err(super::SpaceSyncError::UnauthorizedTarget)
        ));
    }

    #[test]
    fn revocation_purges_an_already_staged_terminal_page() {
        let mut store = authorized_store();
        let prepared = prepare_space_page(
            target(&store),
            SpacePage {
                ops: vec![SpaceRepoOp {
                    collection: POST_COLLECTION.to_owned(),
                    rkey: "see-you".to_owned(),
                    cid: Some(CID.to_owned()),
                    value: Some(json!({ "$type": POST_COLLECTION })),
                }],
                next_cursor: None,
            },
            NOW,
        )
        .unwrap();
        stage_space_page(&mut store, prepared).unwrap();
        store
            .replace_pds_space_members(BOUNDARY, vec![], "2026-09-22T00:01:00.000Z")
            .unwrap();

        assert!(matches!(
            store.promote_authorized_space_stage(
                BOUNDARY,
                SPACE,
                ACTOR,
                "2026-09-23T00:00:00.000Z",
            ),
            Err(crate::store::StoreError::UnauthorizedSpaceMember)
        ));
        assert!(
            store
                .list_posts_by_boundary(BOUNDARY, None, 50, NOW)
                .unwrap()
                .posts
                .is_empty()
        );
    }

    #[test]
    fn skips_oversized_untrusted_fields_and_values_before_staging() {
        let store = authorized_store();
        let prepared = prepare_space_page(
            target(&store),
            SpacePage {
                ops: vec![
                    SpaceRepoOp {
                        collection: POST_COLLECTION.to_owned(),
                        rkey: "x".repeat(513),
                        cid: Some(CID.to_owned()),
                        value: Some(json!({ "$type": POST_COLLECTION })),
                    },
                    SpaceRepoOp {
                        collection: POST_COLLECTION.to_owned(),
                        rkey: "large".to_owned(),
                        cid: Some(CID.to_owned()),
                        value: Some(json!({
                            "$type": POST_COLLECTION,
                            "text": "x".repeat(super::MAX_SPACE_RECORD_BYTES)
                        })),
                    },
                ],
                next_cursor: None,
            },
            NOW,
        )
        .unwrap();

        assert!(prepared.mutations.is_empty());
        assert_eq!(prepared.skipped, 2);
    }
}

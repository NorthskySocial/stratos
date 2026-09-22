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

/// A member is syncable only when an authority-derived membership pass supplies
/// this target. Records themselves never choose the boundary used for staging.
pub struct SpaceSyncTarget<'a> {
    pub space_uri: &'a str,
    pub boundary: &'a str,
    pub actor_did: &'a str,
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
    pub page: SpaceStagePage,
    pub mutations: Vec<SpaceStageMutation>,
    pub indexed: u16,
    pub deleted: u16,
    pub skipped: u16,
}

#[derive(Debug)]
pub enum SpaceSyncError {
    InvalidTarget,
    InvalidPage,
    InvalidTimestamp,
    Store(StoreError),
}

impl std::fmt::Display for SpaceSyncError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("space sync page is invalid")
    }
}

impl std::error::Error for SpaceSyncError {}

/// Validates and stages only inline post values from one bounded PDS page.
/// A terminal page remains unqueryable because promotion requires independent
/// commit verification in the caller.
pub fn prepare_space_page(
    target: SpaceSyncTarget<'_>,
    page: SpacePage,
    updated_at: &str,
) -> Result<PreparedSpacePage, SpaceSyncError> {
    validate_target(&target, updated_at)?;
    if page.ops.len() > MAX_SPACE_PAGE_OPS
        || page
            .next_cursor
            .as_deref()
            .is_some_and(|cursor| cursor.is_empty() || cursor.len() > MAX_CURSOR_BYTES)
    {
        return Err(SpaceSyncError::InvalidPage);
    }

    let mut latest = BTreeMap::new();
    for op in page.ops {
        latest.insert((op.collection.clone(), op.rkey.clone()), op);
    }

    let mut mutations = Vec::new();
    let mut indexed = 0;
    let mut deleted = 0;
    let mut skipped = 0;
    for (_, op) in latest {
        if op.collection != POST_COLLECTION {
            continue;
        }
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
        let Some(record) = value.as_object() else {
            skipped += 1;
            continue;
        };
        if record.get("$type").and_then(Value::as_str) != Some(POST_COLLECTION) {
            skipped += 1;
            continue;
        }
        let Ok(cid) = Cid::try_from(cid.as_str()) else {
            skipped += 1;
            continue;
        };
        let Ok(record_json) = serde_json::to_vec(&value) else {
            skipped += 1;
            continue;
        };
        if record_json.len() > MAX_SPACE_RECORD_BYTES {
            skipped += 1;
            continue;
        }
        let sort_at = record
            .get("createdAt")
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
    Ok(PreparedSpacePage {
        page: SpaceStagePage {
            space_uri: target.space_uri.to_owned(),
            actor_did: target.actor_did.to_owned(),
            boundary: target.boundary.to_owned(),
            next_cursor: page.next_cursor,
            updated_at: updated_at.to_owned(),
        },
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
    store
        .stage_space_page(prepared.page, prepared.mutations)
        .map_err(SpaceSyncError::Store)
}

fn validate_target(target: &SpaceSyncTarget<'_>, updated_at: &str) -> Result<(), SpaceSyncError> {
    if target.boundary.is_empty()
        || Did::parse(target.actor_did.to_owned()).is_err()
        || !is_utc_timestamp(updated_at)
    {
        return Err(if is_utc_timestamp(updated_at) {
            SpaceSyncError::InvalidTarget
        } else {
            SpaceSyncError::InvalidTimestamp
        });
    }
    let probe = format!(
        "{}/{}/{}/probe",
        target.space_uri, target.actor_did, POST_COLLECTION
    );
    match RecordUri::parse_space_record(&probe) {
        Ok(RecordUri::Space { author, .. }) if author.as_str() == target.actor_did => Ok(()),
        _ => Err(SpaceSyncError::InvalidTarget),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        POST_COLLECTION, SpacePage, SpaceRepoOp, SpaceSyncTarget, prepare_space_page,
        stage_space_page,
    };
    use crate::store::{EncryptedStore, StorageKey};

    const SPACE: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop";
    const ACTOR: &str = "did:plc:fayevalentine";
    const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const NOW: &str = "2026-09-22T00:00:00.000Z";
    const CID: &str = "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn target() -> SpaceSyncTarget<'static> {
        SpaceSyncTarget {
            space_uri: SPACE,
            boundary: BOUNDARY,
            actor_did: ACTOR,
        }
    }

    #[test]
    fn stamps_authority_boundary_instead_of_pds_record_boundary() {
        let prepared = prepare_space_page(
            target(),
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
        let prepared = prepare_space_page(
            target(),
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
        let prepared = prepare_space_page(
            target(),
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
        let prepared = prepare_space_page(
            target(),
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
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        stage_space_page(&mut store, prepared).unwrap();

        assert!(
            store
                .list_posts_by_boundary(BOUNDARY, None, 50, NOW)
                .unwrap()
                .posts
                .is_empty()
        );
        store
            .promote_verified_space_stage(SPACE, ACTOR, "2026-09-23T00:00:00.000Z")
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
}

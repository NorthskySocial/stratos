use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine, engine::general_purpose::STANDARD};
use cid::Cid;
use serde::Deserialize;
use serde_cbor::Value as CborValue;
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::{
    authority::normalize_boundary,
    identifier::{Did, RecordUri},
    store::{ActorPage, ProjectionPost, is_utc_timestamp},
};

const POST_COLLECTION: &str = "zone.stratos.feed.post";
const MAX_ACTOR_FRAME_BYTES: usize = 32 * 1024;
const MAX_BOUNDARIES: usize = 128;
const MAX_BOUNDARY_BYTES: usize = 256;
const MAX_BLOB_REFS: usize = 128;
const MAX_VALUE_DEPTH: usize = 32;

#[derive(Debug, Eq, PartialEq)]
pub enum ActorEventError {
    InvalidConfiguration,
    FrameTooLarge,
    InvalidFrame,
}

impl std::fmt::Display for ActorEventError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("actor commit event is invalid")
    }
}

impl std::error::Error for ActorEventError {}

/// Decodes one actor-scoped commit and keeps only posts authorized by the
/// actor's current authority enrollment. Empty authorization becomes a delete
/// in the same durable cursor transaction, preventing stale post retention.
pub fn parse_actor_commit(
    frame: &[u8],
    service_did: &str,
    actor_did: &str,
    authorized_boundaries: &BTreeSet<String>,
    retained_at: &str,
) -> Result<Option<ActorPage>, ActorEventError> {
    if frame.len() > MAX_ACTOR_FRAME_BYTES {
        return Err(ActorEventError::FrameTooLarge);
    }
    Did::parse(service_did.to_owned()).map_err(|_| ActorEventError::InvalidConfiguration)?;
    Did::parse(actor_did.to_owned()).map_err(|_| ActorEventError::InvalidConfiguration)?;
    if !is_utc_timestamp(retained_at) {
        return Err(ActorEventError::InvalidConfiguration);
    }

    let mut deserializer = serde_cbor::de::Deserializer::from_slice(frame);
    let header =
        FrameHeader::deserialize(&mut deserializer).map_err(|_| ActorEventError::InvalidFrame)?;
    if header.kind != "#commit" {
        return Ok(None);
    }
    let commit =
        RawCommit::deserialize(&mut deserializer).map_err(|_| ActorEventError::InvalidFrame)?;
    if deserializer.byte_offset() != frame.len() {
        return Err(ActorEventError::InvalidFrame);
    }
    if commit.did != actor_did || !is_utc_timestamp(&commit.time) || commit.rev.is_empty() {
        return Err(ActorEventError::InvalidFrame);
    }

    let mut mutations = BTreeMap::new();
    for operation in commit.ops {
        let path = operation.path.trim_start_matches('/');
        let Some(record_key) = path.strip_prefix(&format!("{POST_COLLECTION}/")) else {
            continue;
        };
        if record_key.is_empty() {
            return Err(ActorEventError::InvalidFrame);
        }
        let uri = format!("at://{actor_did}/{POST_COLLECTION}/{record_key}");
        match RecordUri::parse(&uri) {
            Ok(RecordUri::Repo {
                author, collection, ..
            }) if author.as_str() == actor_did && collection == POST_COLLECTION => {}
            _ => return Err(ActorEventError::InvalidFrame),
        }

        match operation.action.as_str() {
            "delete" => {
                mutations.insert(uri, PostMutation::Delete);
            }
            "create" | "update" => {
                let record = operation.record.ok_or(ActorEventError::InvalidFrame)?;
                if record_type(&record) != Some(POST_COLLECTION) {
                    return Err(ActorEventError::InvalidFrame);
                }
                let cid = cid_text(
                    operation
                        .cid
                        .as_ref()
                        .ok_or(ActorEventError::InvalidFrame)?,
                )?;
                let boundaries = match map_field(&record, "boundary") {
                    Some(boundary) => {
                        current_boundaries(boundary, service_did, authorized_boundaries)?
                    }
                    None => Vec::new(),
                };
                let sort_at = created_at(&record).unwrap_or(&commit.time).to_owned();
                let record_value = cbor_to_json(&record)?;
                let record_json =
                    serde_json::to_vec(&record_value).map_err(|_| ActorEventError::InvalidFrame)?;
                let blob_refs_json = serde_json::to_vec(&blob_references(&record_value)?)
                    .map_err(|_| ActorEventError::InvalidFrame)?;
                mutations.insert(
                    uri.clone(),
                    PostMutation::Upsert(Box::new(ProjectionPost {
                        uri,
                        author_did: actor_did.to_owned(),
                        cid,
                        sort_at,
                        indexed_at: commit.time.clone(),
                        retained_at: retained_at.to_owned(),
                        record_json,
                        blob_refs_json,
                        boundaries,
                    })),
                );
            }
            _ => return Err(ActorEventError::InvalidFrame),
        }
    }

    let mut upserts = Vec::new();
    let mut deletes = Vec::new();
    for (uri, mutation) in mutations {
        match mutation {
            PostMutation::Upsert(post) if post.boundaries.is_empty() => deletes.push(uri),
            PostMutation::Upsert(post) => upserts.push(*post),
            PostMutation::Delete => deletes.push(uri),
        }
    }
    Ok(Some(ActorPage {
        authority_did: service_did.to_owned(),
        actor_did: actor_did.to_owned(),
        sequence: commit.seq,
        upserts,
        deletes,
        updated_at: commit.time,
    }))
}

#[derive(Deserialize)]
struct FrameHeader {
    #[serde(rename = "t")]
    kind: String,
}

#[derive(Deserialize)]
struct RawCommit {
    seq: u64,
    did: String,
    time: String,
    rev: String,
    ops: Vec<RawOperation>,
}

#[derive(Deserialize)]
struct RawOperation {
    action: String,
    path: String,
    cid: Option<CborValue>,
    record: Option<CborValue>,
}

enum PostMutation {
    Upsert(Box<ProjectionPost>),
    Delete,
}

fn record_type(record: &CborValue) -> Option<&str> {
    map_field(record, "$type").and_then(text_value)
}

fn created_at(record: &CborValue) -> Option<&str> {
    map_field(record, "createdAt")
        .and_then(text_value)
        .filter(|value| crate::store::is_post_sort_timestamp(value))
}

fn current_boundaries(
    boundary: &CborValue,
    service_did: &str,
    authorized_boundaries: &BTreeSet<String>,
) -> Result<Vec<String>, ActorEventError> {
    let Some(values) = map_field(boundary, "values") else {
        return Ok(Vec::new());
    };
    let CborValue::Array(values) = values else {
        return Err(ActorEventError::InvalidFrame);
    };
    if values.len() > MAX_BOUNDARIES {
        return Err(ActorEventError::InvalidFrame);
    }
    let mut current = BTreeSet::new();
    for value in values {
        let boundary = map_field(value, "value")
            .and_then(text_value)
            .filter(|boundary| {
                !boundary.is_empty() && boundary.len() <= MAX_BOUNDARY_BYTES && boundary.is_ascii()
            })
            .ok_or(ActorEventError::InvalidFrame)?;
        if let Some(normalized) = normalize_boundary(service_did, boundary)
            && authorized_boundaries.contains(&normalized)
        {
            current.insert(normalized);
        }
    }
    Ok(current.into_iter().collect())
}

fn cid_text(value: &CborValue) -> Result<String, ActorEventError> {
    match value {
        CborValue::Text(cid) if !cid.is_empty() && cid.len() <= 512 => Ok(cid.clone()),
        CborValue::Tag(42, value) => cid_from_tag(value),
        _ => Err(ActorEventError::InvalidFrame),
    }
}

fn cid_from_tag(value: &CborValue) -> Result<String, ActorEventError> {
    let CborValue::Bytes(bytes) = value else {
        return Err(ActorEventError::InvalidFrame);
    };
    let Some((prefix, raw_cid)) = bytes.split_first() else {
        return Err(ActorEventError::InvalidFrame);
    };
    if *prefix != 0 {
        return Err(ActorEventError::InvalidFrame);
    }
    Cid::try_from(raw_cid)
        .map(|cid| cid.to_string())
        .map_err(|_| ActorEventError::InvalidFrame)
}

fn cbor_to_json(value: &CborValue) -> Result<JsonValue, ActorEventError> {
    cbor_to_json_at_depth(value, 0)
}

fn cbor_to_json_at_depth(value: &CborValue, depth: usize) -> Result<JsonValue, ActorEventError> {
    if depth > MAX_VALUE_DEPTH {
        return Err(ActorEventError::InvalidFrame);
    }
    match value {
        CborValue::Null => Ok(JsonValue::Null),
        CborValue::Bool(value) => Ok(JsonValue::Bool(*value)),
        CborValue::Integer(value) => {
            let value = i64::try_from(*value).map_err(|_| ActorEventError::InvalidFrame)?;
            Ok(JsonValue::Number(value.into()))
        }
        CborValue::Float(value) => serde_json::Number::from_f64(*value)
            .map(JsonValue::Number)
            .ok_or(ActorEventError::InvalidFrame),
        CborValue::Bytes(value) => Ok(JsonValue::Object(JsonMap::from_iter([(
            "$bytes".to_owned(),
            JsonValue::String(STANDARD.encode(value)),
        )]))),
        CborValue::Text(value) => Ok(JsonValue::String(value.clone())),
        CborValue::Array(values) => values
            .iter()
            .map(|value| cbor_to_json_at_depth(value, depth + 1))
            .collect::<Result<Vec<_>, _>>()
            .map(JsonValue::Array),
        CborValue::Map(values) => {
            let mut object = JsonMap::new();
            for (key, value) in values {
                let CborValue::Text(key) = key else {
                    return Err(ActorEventError::InvalidFrame);
                };
                object.insert(key.clone(), cbor_to_json_at_depth(value, depth + 1)?);
            }
            Ok(JsonValue::Object(object))
        }
        CborValue::Tag(42, value) => Ok(JsonValue::Object(JsonMap::from_iter([(
            "$link".to_owned(),
            JsonValue::String(cid_from_tag(value)?),
        )]))),
        CborValue::Tag(_, _) | CborValue::__Hidden => Err(ActorEventError::InvalidFrame),
    }
}

fn map_field<'a>(value: &'a CborValue, key: &str) -> Option<&'a CborValue> {
    let CborValue::Map(values) = value else {
        return None;
    };
    values.get(&CborValue::Text(key.to_owned()))
}

fn text_value(value: &CborValue) -> Option<&str> {
    match value {
        CborValue::Text(value) => Some(value),
        _ => None,
    }
}

fn blob_references(record: &JsonValue) -> Result<Vec<JsonValue>, ActorEventError> {
    let mut seen = BTreeSet::new();
    let mut references = Vec::new();
    let Some(embed) = record.get("embed") else {
        return Ok(references);
    };
    collect_blob_references(embed, &mut seen, &mut references, 0)?;
    Ok(references)
}

fn collect_blob_references(
    value: &JsonValue,
    seen: &mut BTreeSet<String>,
    references: &mut Vec<JsonValue>,
    depth: usize,
) -> Result<(), ActorEventError> {
    if depth > MAX_VALUE_DEPTH {
        return Err(ActorEventError::InvalidFrame);
    }
    if references.len() >= MAX_BLOB_REFS {
        return Ok(());
    }
    match value {
        JsonValue::Array(values) => {
            for value in values {
                collect_blob_references(value, seen, references, depth + 1)?;
            }
        }
        JsonValue::Object(values) => {
            if let Some(JsonValue::String(cid)) = values.get("$link") {
                add_blob_reference(cid, values.get("mimeType"), seen, references);
            }
            if let Some(JsonValue::Object(reference)) = values.get("ref")
                && let Some(JsonValue::String(cid)) = reference.get("$link")
            {
                add_blob_reference(cid, values.get("mimeType"), seen, references);
            }
            for value in values.values() {
                collect_blob_references(value, seen, references, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn add_blob_reference(
    cid: &str,
    mime_type: Option<&JsonValue>,
    seen: &mut BTreeSet<String>,
    references: &mut Vec<JsonValue>,
) {
    if references.len() >= MAX_BLOB_REFS || !seen.insert(cid.to_owned()) {
        return;
    }
    let mut reference = JsonMap::from_iter([("cid".to_owned(), JsonValue::String(cid.to_owned()))]);
    if let Some(JsonValue::String(mime_type)) = mime_type {
        reference.insert("mimeType".to_owned(), JsonValue::String(mime_type.clone()));
    }
    references.push(JsonValue::Object(reference));
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use serde::Serialize;
    use serde_cbor::Value as CborValue;

    use super::{ActorEventError, POST_COLLECTION, created_at, parse_actor_commit};

    #[derive(Serialize)]
    struct Header<'a> {
        #[serde(rename = "t")]
        kind: &'a str,
    }

    #[derive(Serialize)]
    struct Commit {
        seq: u64,
        did: &'static str,
        time: &'static str,
        rev: &'static str,
        ops: Vec<Operation>,
    }

    #[derive(Serialize)]
    struct Operation {
        action: &'static str,
        path: &'static str,
        cid: Option<CborValue>,
        record: Option<CborValue>,
        boundary: Option<CborValue>,
    }

    fn boundary(values: &[&str]) -> CborValue {
        CborValue::Map(BTreeMap::from([(
            CborValue::Text("values".to_owned()),
            CborValue::Array(
                values
                    .iter()
                    .map(|value| {
                        CborValue::Map(BTreeMap::from([(
                            CborValue::Text("value".to_owned()),
                            CborValue::Text((*value).to_owned()),
                        )]))
                    })
                    .collect(),
            ),
        )]))
    }

    fn record(created_at: &str, boundaries: &[&str]) -> CborValue {
        CborValue::Map(BTreeMap::from([
            (
                CborValue::Text("$type".to_owned()),
                CborValue::Text(POST_COLLECTION.to_owned()),
            ),
            (
                CborValue::Text("createdAt".to_owned()),
                CborValue::Text(created_at.to_owned()),
            ),
            (CborValue::Text("boundary".to_owned()), boundary(boundaries)),
        ]))
    }

    fn frame(ops: Vec<Operation>) -> Vec<u8> {
        let mut frame = serde_cbor::to_vec(&Header { kind: "#commit" }).unwrap();
        frame.extend(
            serde_cbor::to_vec(&Commit {
                seq: 7,
                did: "did:plc:faye",
                time: "1998-04-03T00:00:00.000Z",
                rev: "3jzfcijpj2z2a",
                ops,
            })
            .unwrap(),
        );
        frame
    }

    fn authorized() -> BTreeSet<String> {
        ["did:web:stratos.example.test/bebop".to_owned()]
            .into_iter()
            .collect()
    }

    #[test]
    fn preserves_valid_utc_microseconds_for_feed_order() {
        let timestamp = "1998-04-03T00:00:00.123456+00:00";
        let post = record(timestamp, &["bebop"]);
        assert_eq!(created_at(&post), Some(timestamp));
        assert_eq!(created_at(&record("not-a-date", &["bebop"])), None);
        assert_eq!(
            created_at(&record("1998-04-03T02:00:00.123456+02:00", &["bebop"])),
            None
        );
    }

    #[test]
    fn projects_only_currently_authorized_posts_and_preserves_delete_order() {
        let parsed = parse_actor_commit(
            &frame(vec![
                Operation {
                    action: "create",
                    path: "zone.stratos.feed.post/see-you",
                    cid: Some(CborValue::Text("bafyreia".to_owned())),
                    record: Some(record("1998-04-02T00:00:00.000Z", &["bebop", "crew"])),
                    boundary: None,
                },
                Operation {
                    action: "delete",
                    path: "zone.stratos.feed.post/see-you",
                    cid: None,
                    record: None,
                    boundary: None,
                },
                Operation {
                    action: "create",
                    path: "zone.stratos.feed.post/ed",
                    cid: Some(CborValue::Text("bafyreie".to_owned())),
                    record: Some(record("invalid", &["crew"])),
                    boundary: Some(boundary(&["bebop"])),
                },
            ]),
            "did:web:stratos.example.test",
            "did:plc:faye",
            &authorized(),
            "1998-05-03T00:00:00.000Z",
        )
        .unwrap()
        .unwrap();

        assert_eq!(parsed.sequence, 7);
        assert_eq!(parsed.upserts.len(), 0);
        assert_eq!(
            parsed.deletes,
            [
                "at://did:plc:faye/zone.stratos.feed.post/ed",
                "at://did:plc:faye/zone.stratos.feed.post/see-you"
            ]
        );
    }

    #[test]
    fn rejects_forged_actor_frames_and_incomplete_post_updates() {
        let forged = serde_cbor::to_vec(&Header { kind: "#commit" }).unwrap();
        let mut forged = forged;
        forged.extend(
            serde_cbor::to_vec(&Commit {
                seq: 7,
                did: "did:plc:spike",
                time: "1998-04-03T00:00:00.000Z",
                rev: "3jzfcijpj2z2a",
                ops: Vec::new(),
            })
            .unwrap(),
        );
        assert!(matches!(
            parse_actor_commit(
                &forged,
                "did:web:stratos.example.test",
                "did:plc:faye",
                &authorized(),
                "1998-05-03T00:00:00.000Z",
            ),
            Err(ActorEventError::InvalidFrame)
        ));

        let incomplete = frame(vec![Operation {
            action: "update",
            path: "zone.stratos.feed.post/see-you",
            cid: None,
            record: Some(record("1998-04-02T00:00:00.000Z", &["bebop"])),
            boundary: None,
        }]);
        assert!(matches!(
            parse_actor_commit(
                &incomplete,
                "did:web:stratos.example.test",
                "did:plc:faye",
                &authorized(),
                "1998-05-03T00:00:00.000Z",
            ),
            Err(ActorEventError::InvalidFrame)
        ));
    }

    #[test]
    fn preserves_dag_cbor_cid_links_inside_post_json() {
        let mut cid = vec![0, 1, 0x55, 0x12, 32];
        cid.extend([7; 32]);
        let mut post = record("1998-04-02T00:00:00.000Z", &["bebop"]);
        let CborValue::Map(post_map) = &mut post else {
            unreachable!();
        };
        post_map.insert(
            CborValue::Text("embed".to_owned()),
            CborValue::Map(BTreeMap::from([(
                CborValue::Text("image".to_owned()),
                CborValue::Map(BTreeMap::from([
                    (
                        CborValue::Text("ref".to_owned()),
                        CborValue::Tag(42, Box::new(CborValue::Bytes(cid.clone()))),
                    ),
                    (
                        CborValue::Text("mimeType".to_owned()),
                        CborValue::Text("image/png".to_owned()),
                    ),
                ])),
            )])),
        );
        let page = parse_actor_commit(
            &frame(vec![Operation {
                action: "create",
                path: "zone.stratos.feed.post/see-you",
                cid: Some(CborValue::Tag(42, Box::new(CborValue::Bytes(cid)))),
                record: Some(post),
                boundary: None,
            }]),
            "did:web:stratos.example.test",
            "did:plc:faye",
            &authorized(),
            "1998-05-03T00:00:00.000Z",
        )
        .unwrap()
        .unwrap();
        let record: serde_json::Value =
            serde_json::from_slice(&page.upserts[0].record_json).unwrap();
        assert!(
            record["embed"]["image"]["ref"]["$link"]
                .as_str()
                .unwrap()
                .starts_with("baf")
        );
        let blobs: serde_json::Value =
            serde_json::from_slice(&page.upserts[0].blob_refs_json).unwrap();
        assert_eq!(blobs.as_array().unwrap().len(), 1);
        assert_eq!(blobs[0]["mimeType"], "image/png");
    }

    #[test]
    fn rejects_deeply_nested_record_values() {
        let mut nested = CborValue::Text("bang".to_owned());
        for _ in 0..=super::MAX_VALUE_DEPTH {
            nested = CborValue::Array(vec![nested]);
        }
        let mut post = record("1998-04-02T00:00:00.000Z", &["bebop"]);
        let CborValue::Map(post_map) = &mut post else {
            unreachable!();
        };
        post_map.insert(CborValue::Text("nested".to_owned()), nested);
        let event = frame(vec![Operation {
            action: "create",
            path: "zone.stratos.feed.post/see-you",
            cid: Some(CborValue::Text("bafyreia".to_owned())),
            record: Some(post),
            boundary: None,
        }]);
        assert!(matches!(
            parse_actor_commit(
                &event,
                "did:web:stratos.example.test",
                "did:plc:faye",
                &authorized(),
                "1998-05-03T00:00:00.000Z",
            ),
            Err(ActorEventError::InvalidFrame)
        ));
    }
}

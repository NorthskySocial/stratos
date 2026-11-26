use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine, engine::general_purpose::STANDARD};
use cid::Cid;
use serde::Deserialize;
use serde_cbor::Value as CborValue;
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::{
    authority::normalize_boundary,
    config::MAX_ACTOR_FRAME_BYTES,
    identifier::{Did, RecordUri},
    store::{
        ActorPage, InteractionChanges, InteractionKind, MAX_SUBJECT_URI_BYTES,
        ProjectionInteraction, ProjectionPost, is_utc_timestamp,
    },
};

const POST_COLLECTION: &str = "zone.stratos.feed.post";
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
///
/// A post's boundary comes from the operation when it has one: the authority
/// sets that field, while the body boundary is only the author's claim. The
/// body is read solely for operations recorded before the authority set the
/// operation boundary. A null operation boundary counts as absent.
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

    let context = InteractionContext {
        service_did,
        actor_did,
        authorized_boundaries,
        indexed_at: &commit.time,
        retained_at,
    };
    let mut mutations = BTreeMap::new();
    let mut interaction_mutations = BTreeMap::new();
    let mut skipped_interactions = 0_usize;
    for operation in commit.ops {
        let path = operation.path.trim_start_matches('/');
        let Some(record_key) = path.strip_prefix(&format!("{POST_COLLECTION}/")) else {
            if let Some((kind, record_key)) = interaction_route(path) {
                match interaction_mutation(&operation, kind, record_key, &context) {
                    Some((uri, mutation)) => {
                        interaction_mutations.insert(uri, mutation);
                    }
                    None => skipped_interactions += 1,
                }
            } else if operation_action(&operation).is_none() {
                // Only likes and reposts may carry an unreadable action.
                return Err(ActorEventError::InvalidFrame);
            }
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

        match operation_action(&operation) {
            Some("delete") => {
                mutations.insert(uri, PostMutation::Delete);
            }
            Some("create" | "update") => {
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
                let boundary = operation
                    .boundary
                    .as_ref()
                    .or_else(|| map_field(&record, "boundary"));
                let boundaries = match boundary {
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
    let mut interactions = InteractionChanges::default();
    for (uri, mutation) in interaction_mutations {
        match mutation {
            InteractionMutation::Upsert(interaction) => interactions.upserts.push(*interaction),
            InteractionMutation::Delete => interactions.deletes.push(uri),
        }
    }
    if skipped_interactions > 0 {
        eprintln!("event=actor_interaction_skipped count={skipped_interactions}");
    }
    Ok(Some(ActorPage {
        authority_did: service_did.to_owned(),
        actor_did: actor_did.to_owned(),
        sequence: commit.seq,
        upserts,
        deletes,
        interactions,
        updated_at: commit.time,
    }))
}

struct InteractionContext<'a> {
    service_did: &'a str,
    actor_did: &'a str,
    authorized_boundaries: &'a BTreeSet<String>,
    indexed_at: &'a str,
    retained_at: &'a str,
}

fn interaction_route(path: &str) -> Option<(InteractionKind, &str)> {
    let (collection, record_key) = path.split_once('/')?;
    let kind = InteractionKind::from_collection(collection)?;
    Some((kind, record_key))
}

/// A like or repost that cannot be read is skipped rather than failing the
/// frame, so one bad record cannot stall an actor's stream or its posts.
fn interaction_mutation(
    operation: &RawOperation,
    kind: InteractionKind,
    record_key: &str,
    context: &InteractionContext<'_>,
) -> Option<(String, InteractionMutation)> {
    let uri = format!(
        "at://{}/{}/{record_key}",
        context.actor_did,
        kind.collection()
    );
    match RecordUri::parse(&uri) {
        Ok(RecordUri::Repo {
            author, collection, ..
        }) if author.as_str() == context.actor_did && collection == kind.collection() => {}
        _ => return None,
    }
    let mutation = match operation_action(operation)? {
        "delete" => InteractionMutation::Delete,
        "create" | "update" => {
            let record = operation.record.as_ref()?;
            if record_type(record) != Some(kind.collection()) {
                return None;
            }
            let subject_uri = map_field(record, "subject")
                .and_then(|subject| map_field(subject, "uri"))
                .and_then(text_value)
                .filter(|subject_uri| subject_uri.len() <= MAX_SUBJECT_URI_BYTES)?;
            RecordUri::parse(subject_uri).ok()?;
            let boundary = operation
                .boundary
                .as_ref()
                .or_else(|| map_field(record, "boundary"));
            let boundaries = match boundary {
                Some(boundary) => {
                    current_boundaries(boundary, context.service_did, context.authorized_boundaries)
                        .ok()?
                }
                None => Vec::new(),
            };
            match <[String; 1]>::try_from(boundaries) {
                Ok([boundary]) => InteractionMutation::Upsert(Box::new(ProjectionInteraction {
                    uri: uri.clone(),
                    actor_did: context.actor_did.to_owned(),
                    kind,
                    subject_uri: subject_uri.to_owned(),
                    boundary,
                    indexed_at: context.indexed_at.to_owned(),
                    retained_at: context.retained_at.to_owned(),
                })),
                Err(boundaries) if boundaries.is_empty() => InteractionMutation::Delete,
                Err(_) => return None,
            }
        }
        _ => return None,
    };
    Some((uri, mutation))
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

// The action is read as any value so that one like or repost with an
// unreadable action is skipped instead of failing the whole commit.
#[derive(Deserialize)]
struct RawOperation {
    action: Option<CborValue>,
    path: String,
    cid: Option<CborValue>,
    record: Option<CborValue>,
    boundary: Option<CborValue>,
}

fn operation_action(operation: &RawOperation) -> Option<&str> {
    operation.action.as_ref().and_then(text_value)
}

enum InteractionMutation {
    Upsert(Box<ProjectionInteraction>),
    Delete,
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

    use super::{
        ActorEventError, MAX_SUBJECT_URI_BYTES, POST_COLLECTION, created_at, parse_actor_commit,
    };
    use crate::store::{InteractionChanges, InteractionKind, ProjectionInteraction};

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
    struct CommitWithoutBoundaryKeys {
        seq: u64,
        did: &'static str,
        time: &'static str,
        rev: &'static str,
        ops: Vec<OperationWithoutBoundaryKey>,
    }

    #[derive(Serialize)]
    struct OperationWithoutBoundaryKey {
        action: &'static str,
        path: &'static str,
        cid: Option<CborValue>,
        record: Option<CborValue>,
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
        record_with_body_boundary(created_at, Some(boundary(boundaries)))
    }

    fn record_with_body_boundary(created_at: &str, body_boundary: Option<CborValue>) -> CborValue {
        let mut fields = BTreeMap::from([
            (
                CborValue::Text("$type".to_owned()),
                CborValue::Text(POST_COLLECTION.to_owned()),
            ),
            (
                CborValue::Text("createdAt".to_owned()),
                CborValue::Text(created_at.to_owned()),
            ),
        ]);
        if let Some(body_boundary) = body_boundary {
            fields.insert(CborValue::Text("boundary".to_owned()), body_boundary);
        }
        CborValue::Map(fields)
    }

    fn boundary_values_not_an_array() -> CborValue {
        CborValue::Map(BTreeMap::from([(
            CborValue::Text("values".to_owned()),
            CborValue::Text("bebop".to_owned()),
        )]))
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
        assert_eq!(parsed.upserts.len(), 1);
        assert_eq!(
            parsed.upserts[0].uri,
            "at://did:plc:faye/zone.stratos.feed.post/ed"
        );
        assert_eq!(
            parsed.upserts[0].boundaries,
            ["did:web:stratos.example.test/bebop"]
        );
        assert_eq!(
            parsed.deletes,
            ["at://did:plc:faye/zone.stratos.feed.post/see-you"]
        );
    }

    const SERVICE: &str = "did:web:stratos.example.test";
    const BEBOP: &str = "did:web:stratos.example.test/bebop";
    const CREATED_AT: &str = "1998-04-02T00:00:00.000Z";

    fn create_op(record: CborValue, op_boundary: Option<CborValue>) -> Operation {
        Operation {
            action: "create",
            path: "zone.stratos.feed.post/ed",
            cid: Some(CborValue::Text("bafyreie".to_owned())),
            record: Some(record),
            boundary: op_boundary,
        }
    }

    fn parse_one(
        op: Operation,
        authorized: &BTreeSet<String>,
    ) -> Result<crate::store::ActorPage, ActorEventError> {
        parse_actor_commit(
            &frame(vec![op]),
            SERVICE,
            "did:plc:faye",
            authorized,
            "1998-05-03T00:00:00.000Z",
        )
        .map(|page| page.unwrap())
    }

    fn authorized_for(boundaries: &[&str]) -> BTreeSet<String> {
        boundaries.iter().map(|value| (*value).to_owned()).collect()
    }

    fn only_upsert_boundaries(page: &crate::store::ActorPage) -> Vec<String> {
        assert_eq!(page.upserts.len(), 1);
        assert!(page.deletes.is_empty());
        page.upserts[0].boundaries.clone()
    }

    #[test]
    fn takes_the_boundary_from_the_operation_when_the_body_has_none() {
        let page = parse_one(
            create_op(
                record_with_body_boundary(CREATED_AT, None),
                Some(boundary(&["bebop"])),
            ),
            &authorized(),
        )
        .unwrap();

        assert_eq!(only_upsert_boundaries(&page), [BEBOP]);
        assert_eq!(
            page.upserts[0].uri,
            "at://did:plc:faye/zone.stratos.feed.post/ed"
        );
    }

    #[test]
    fn falls_back_to_the_body_boundary_when_the_operation_has_none() {
        let body_only = record(CREATED_AT, &["bebop"]);
        let mut absent_key = serde_cbor::to_vec(&Header { kind: "#commit" }).unwrap();
        absent_key.extend(
            serde_cbor::to_vec(&CommitWithoutBoundaryKeys {
                seq: 7,
                did: "did:plc:faye",
                time: "1998-04-03T00:00:00.000Z",
                rev: "3jzfcijpj2z2a",
                ops: vec![OperationWithoutBoundaryKey {
                    action: "create",
                    path: "zone.stratos.feed.post/ed",
                    cid: Some(CborValue::Text("bafyreie".to_owned())),
                    record: Some(body_only.clone()),
                }],
            })
            .unwrap(),
        );
        let from_absent_key = parse_actor_commit(
            &absent_key,
            SERVICE,
            "did:plc:faye",
            &authorized(),
            "1998-05-03T00:00:00.000Z",
        )
        .unwrap()
        .unwrap();
        let from_null = parse_one(create_op(body_only, None), &authorized()).unwrap();

        for page in [&from_absent_key, &from_null] {
            assert_eq!(only_upsert_boundaries(page), [BEBOP]);
            let post = &page.upserts[0];
            assert_eq!(post.uri, "at://did:plc:faye/zone.stratos.feed.post/ed");
            assert_eq!(post.cid, "bafyreie");
            assert_eq!(post.sort_at, CREATED_AT);
            assert_eq!(post.indexed_at, "1998-04-03T00:00:00.000Z");
        }
        assert_eq!(
            from_absent_key.upserts[0].record_json,
            from_null.upserts[0].record_json
        );
    }

    fn parse_with_absent_operation_boundary_key(body: CborValue) -> crate::store::ActorPage {
        let mut bytes = serde_cbor::to_vec(&Header { kind: "#commit" }).unwrap();
        bytes.extend(
            serde_cbor::to_vec(&CommitWithoutBoundaryKeys {
                seq: 7,
                did: "did:plc:faye",
                time: "1998-04-03T00:00:00.000Z",
                rev: "3jzfcijpj2z2a",
                ops: vec![OperationWithoutBoundaryKey {
                    action: "create",
                    path: "zone.stratos.feed.post/ed",
                    cid: Some(CborValue::Text("bafyreie".to_owned())),
                    record: Some(body),
                }],
            })
            .unwrap(),
        );
        parse_actor_commit(
            &bytes,
            SERVICE,
            "did:plc:faye",
            &authorized(),
            "1998-05-03T00:00:00.000Z",
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn the_body_fallback_is_still_limited_to_current_enrollment() {
        let ed = "at://did:plc:faye/zone.stratos.feed.post/ed";
        let bodies = [("crew", vec!["crew"]), ("mixed", vec!["bebop", "crew"])];
        for (label, claimed) in bodies {
            let body = record(CREATED_AT, &claimed);
            let pages = [
                parse_with_absent_operation_boundary_key(body.clone()),
                parse_one(create_op(body, None), &authorized()).unwrap(),
            ];
            for page in pages {
                if label == "crew" {
                    assert!(page.upserts.is_empty());
                    assert_eq!(page.deletes, [ed]);
                } else {
                    assert_eq!(only_upsert_boundaries(&page), [BEBOP]);
                }
            }
        }
    }

    #[test]
    fn an_operation_boundary_without_usable_values_is_a_delete_and_the_body_is_not_read() {
        let map_without_values = CborValue::Map(BTreeMap::from([(
            CborValue::Text("note".to_owned()),
            CborValue::Text("bebop".to_owned()),
        )]));
        let not_a_map = CborValue::Text("bebop".to_owned());
        for op_boundary in [map_without_values, not_a_map] {
            let page = parse_one(
                create_op(record(CREATED_AT, &["bebop"]), Some(op_boundary)),
                &authorized(),
            )
            .unwrap();
            assert!(page.upserts.is_empty());
            assert_eq!(
                page.deletes,
                ["at://did:plc:faye/zone.stratos.feed.post/ed"]
            );
        }
    }

    #[test]
    fn the_operation_boundary_wins_over_a_disagreeing_body_claim() {
        let operation_authorized = parse_one(
            create_op(record(CREATED_AT, &["crew"]), Some(boundary(&["bebop"]))),
            &authorized(),
        )
        .unwrap();
        assert_eq!(only_upsert_boundaries(&operation_authorized), [BEBOP]);

        let operation_unauthorized = parse_one(
            create_op(record(CREATED_AT, &["bebop"]), Some(boundary(&["crew"]))),
            &authorized(),
        )
        .unwrap();
        assert!(operation_unauthorized.upserts.is_empty());
        assert_eq!(
            operation_unauthorized.deletes,
            ["at://did:plc:faye/zone.stratos.feed.post/ed"]
        );
    }

    #[test]
    fn the_operation_boundary_is_still_limited_to_current_enrollment() {
        let mixed = parse_one(
            create_op(
                record_with_body_boundary(CREATED_AT, None),
                Some(boundary(&["bebop", "crew"])),
            ),
            &authorized(),
        )
        .unwrap();
        assert_eq!(only_upsert_boundaries(&mixed), [BEBOP]);

        let unauthorized_only = parse_one(
            create_op(
                record_with_body_boundary(CREATED_AT, None),
                Some(boundary(&["crew"])),
            ),
            &authorized(),
        )
        .unwrap();
        assert!(unauthorized_only.upserts.is_empty());
        assert_eq!(unauthorized_only.deletes.len(), 1);
    }

    #[test]
    fn rejects_a_malformed_operation_boundary() {
        let too_many = vec!["bebop"; super::MAX_BOUNDARIES + 1];
        let oversized = "a".repeat(super::MAX_BOUNDARY_BYTES + 1);
        let malformed = [
            boundary_values_not_an_array(),
            boundary(&too_many),
            boundary(&[""]),
            boundary(&[oversized.as_str()]),
            boundary(&["bébop"]),
        ];
        for op_boundary in malformed {
            let result = parse_one(
                create_op(record(CREATED_AT, &["bebop"]), Some(op_boundary)),
                &authorized(),
            );
            assert!(matches!(result, Err(ActorEventError::InvalidFrame)));
        }
    }

    #[test]
    fn does_not_read_the_body_boundary_when_the_operation_has_one() {
        let page = parse_one(
            create_op(
                record_with_body_boundary(CREATED_AT, Some(boundary_values_not_an_array())),
                Some(boundary(&["bebop"])),
            ),
            &authorized(),
        )
        .unwrap();

        assert_eq!(only_upsert_boundaries(&page), [BEBOP]);
    }

    #[test]
    fn drops_operation_boundaries_that_belong_to_another_service() {
        let other_service = "did:web:other.example.test/bebop";
        let enrolled = authorized_for(&[BEBOP, other_service]);

        let mixed = parse_one(
            create_op(
                record_with_body_boundary(CREATED_AT, None),
                Some(boundary(&[other_service, "bebop"])),
            ),
            &enrolled,
        )
        .unwrap();
        assert_eq!(only_upsert_boundaries(&mixed), [BEBOP]);

        let foreign_only = parse_one(
            create_op(
                record_with_body_boundary(CREATED_AT, None),
                Some(boundary(&[other_service])),
            ),
            &enrolled,
        )
        .unwrap();
        assert!(foreign_only.upserts.is_empty());
        assert_eq!(foreign_only.deletes.len(), 1);
    }

    #[test]
    fn a_delete_with_an_operation_boundary_still_deletes() {
        let scoped_removal = Operation {
            action: "delete",
            path: "zone.stratos.feed.post/ed",
            cid: None,
            record: None,
            boundary: Some(boundary(&["crew"])),
        };
        let page = parse_one(scoped_removal, &authorized()).unwrap();

        assert!(page.upserts.is_empty());
        assert_eq!(
            page.deletes,
            ["at://did:plc:faye/zone.stratos.feed.post/ed"]
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

    const FAYE_LIKE_SUBJECT: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/swordfish";
    const FAYE_SPACE_SUBJECT: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/swordfish";
    const LEGACY_SPACE_SUBJECT: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/swordfish";
    const LIKE: &str = "app.bsky.feed.like";
    const REPOST: &str = "app.bsky.feed.repost";
    const CREW: &str = "did:web:stratos.example.test/crew";

    fn text(value: &str) -> CborValue {
        CborValue::Text(value.to_owned())
    }

    fn subject_ref(uri: CborValue) -> CborValue {
        CborValue::Map(BTreeMap::from([
            (text("uri"), uri),
            (text("cid"), text("bafyreib")),
        ]))
    }

    fn interaction_body(
        collection: &str,
        subject: Option<CborValue>,
        body_boundary: Option<CborValue>,
    ) -> CborValue {
        let mut fields = BTreeMap::from([
            (text("$type"), text(collection)),
            (text("createdAt"), text(CREATED_AT)),
        ]);
        if let Some(subject) = subject {
            fields.insert(text("subject"), subject);
        }
        if let Some(body_boundary) = body_boundary {
            fields.insert(text("boundary"), body_boundary);
        }
        CborValue::Map(fields)
    }

    fn valid_body(collection: &str) -> CborValue {
        interaction_body(collection, Some(subject_ref(text(FAYE_LIKE_SUBJECT))), None)
    }

    fn interaction_op(
        action: &'static str,
        path: &'static str,
        record: Option<CborValue>,
        op_boundary: Option<CborValue>,
    ) -> Operation {
        Operation {
            action,
            path,
            cid: Some(text("bafyreie")),
            record,
            boundary: op_boundary,
        }
    }

    fn two_boundaries() -> BTreeSet<String> {
        authorized_for(&[BEBOP, CREW])
    }

    fn faye_uri(collection: &str, rkey: &str) -> String {
        format!("at://did:plc:faye/{collection}/{rkey}")
    }

    fn expected_interaction(
        collection: &str,
        rkey: &str,
        subject: &str,
        boundary: &str,
    ) -> ProjectionInteraction {
        ProjectionInteraction {
            uri: faye_uri(collection, rkey),
            actor_did: "did:plc:faye".to_owned(),
            kind: if collection == LIKE {
                InteractionKind::Like
            } else {
                InteractionKind::Repost
            },
            subject_uri: subject.to_owned(),
            boundary: boundary.to_owned(),
            indexed_at: "1998-04-03T00:00:00.000Z".to_owned(),
            retained_at: "1998-05-03T00:00:00.000Z".to_owned(),
        }
    }

    enum Outcome {
        Upsert(ProjectionInteraction),
        Delete(String),
        Skipped,
    }

    #[test]
    fn reads_likes_and_reposts_by_collection_and_skips_what_is_malformed() {
        let overlong_subject = format!(
            "at://did:plc:{}/zone.stratos.feed.post/swordfish",
            "a".repeat(MAX_SUBJECT_URI_BYTES)
        );
        let cases: Vec<(&str, Operation, Outcome)> = vec![
            (
                "like create with an operation boundary",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(valid_body(LIKE)),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Upsert(expected_interaction(LIKE, "one", FAYE_LIKE_SUBJECT, BEBOP)),
            ),
            (
                "repost create with an operation boundary",
                interaction_op(
                    "create",
                    "app.bsky.feed.repost/two",
                    Some(valid_body(REPOST)),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Upsert(expected_interaction(
                    REPOST,
                    "two",
                    FAYE_LIKE_SUBJECT,
                    BEBOP,
                )),
            ),
            (
                "update behaves as create",
                interaction_op(
                    "update",
                    "app.bsky.feed.like/one",
                    Some(valid_body(LIKE)),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Upsert(expected_interaction(LIKE, "one", FAYE_LIKE_SUBJECT, BEBOP)),
            ),
            (
                "body boundary when the operation has none",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(interaction_body(
                        LIKE,
                        Some(subject_ref(text(FAYE_LIKE_SUBJECT))),
                        Some(boundary(&["bebop"])),
                    )),
                    None,
                ),
                Outcome::Upsert(expected_interaction(LIKE, "one", FAYE_LIKE_SUBJECT, BEBOP)),
            ),
            (
                "the operation boundary wins over the body claim",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(interaction_body(
                        LIKE,
                        Some(subject_ref(text(FAYE_LIKE_SUBJECT))),
                        Some(boundary(&["crew"])),
                    )),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Upsert(expected_interaction(LIKE, "one", FAYE_LIKE_SUBJECT, BEBOP)),
            ),
            (
                "a subject in the space form",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(interaction_body(
                        LIKE,
                        Some(subject_ref(text(FAYE_SPACE_SUBJECT))),
                        None,
                    )),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Upsert(expected_interaction(LIKE, "one", FAYE_SPACE_SUBJECT, BEBOP)),
            ),
            (
                "a subject in the previous space spelling is skipped like any unparseable subject",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(interaction_body(
                        LIKE,
                        Some(subject_ref(text(LEGACY_SPACE_SUBJECT))),
                        None,
                    )),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Skipped,
            ),
            (
                "an unauthorized boundary becomes a delete",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(valid_body(LIKE)),
                    Some(boundary(&["swordfish"])),
                ),
                Outcome::Delete(faye_uri(LIKE, "one")),
            ),
            (
                "no boundary at all becomes a delete",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(valid_body(LIKE)),
                    None,
                ),
                Outcome::Delete(faye_uri(LIKE, "one")),
            ),
            (
                "two boundaries are skipped",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(valid_body(LIKE)),
                    Some(boundary(&["bebop", "crew"])),
                ),
                Outcome::Skipped,
            ),
            (
                "a wrong $type",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(valid_body(REPOST)),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Skipped,
            ),
            (
                "a missing subject",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(interaction_body(LIKE, None, None)),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Skipped,
            ),
            (
                "a subject uri that is not text",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(interaction_body(
                        LIKE,
                        Some(subject_ref(CborValue::Integer(7))),
                        None,
                    )),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Skipped,
            ),
            (
                "an overlong subject uri",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(interaction_body(
                        LIKE,
                        Some(subject_ref(text(&overlong_subject))),
                        None,
                    )),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Skipped,
            ),
            (
                "an unparseable subject uri",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(interaction_body(
                        LIKE,
                        Some(subject_ref(text("https://example.test/gaghiel"))),
                        None,
                    )),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Skipped,
            ),
            (
                "a boundary body that is not usable",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(valid_body(LIKE)),
                    Some(boundary_values_not_an_array()),
                ),
                Outcome::Skipped,
            ),
            (
                "a create without a record",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    None,
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Skipped,
            ),
            (
                "an unknown action",
                interaction_op(
                    "bogus",
                    "app.bsky.feed.like/one",
                    Some(valid_body(LIKE)),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Skipped,
            ),
            (
                "an empty record key",
                interaction_op(
                    "create",
                    "app.bsky.feed.like/",
                    Some(valid_body(LIKE)),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Skipped,
            ),
            (
                "a delete",
                interaction_op("delete", "app.bsky.feed.repost/two", None, None),
                Outcome::Delete(faye_uri(REPOST, "two")),
            ),
            (
                "another collection stays ignored",
                interaction_op(
                    "create",
                    "app.bsky.graph.follow/three",
                    Some(valid_body(LIKE)),
                    Some(boundary(&["bebop"])),
                ),
                Outcome::Skipped,
            ),
        ];

        for (name, operation, outcome) in cases {
            let page = parse_one(operation, &two_boundaries())
                .unwrap_or_else(|_| panic!("case {name} failed the frame"));
            assert!(page.upserts.is_empty(), "case {name} changed posts");
            assert!(page.deletes.is_empty(), "case {name} deleted posts");
            match outcome {
                Outcome::Upsert(expected) => {
                    assert_eq!(page.interactions.upserts, [expected], "case {name}");
                    assert!(page.interactions.deletes.is_empty(), "case {name}");
                }
                Outcome::Delete(uri) => {
                    assert!(page.interactions.upserts.is_empty(), "case {name}");
                    assert_eq!(page.interactions.deletes, [uri], "case {name}");
                }
                Outcome::Skipped => {
                    assert_eq!(
                        page.interactions,
                        InteractionChanges::default(),
                        "case {name}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_malformed_like_never_changes_the_posts_of_the_same_commit() {
        let page = parse_actor_commit(
            &frame(vec![
                create_op(record(CREATED_AT, &["bebop"]), None),
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(valid_body(REPOST)),
                    Some(boundary(&["bebop"])),
                ),
                interaction_op(
                    "create",
                    "app.bsky.feed.repost/two",
                    Some(valid_body(REPOST)),
                    Some(boundary(&["bebop"])),
                ),
            ]),
            SERVICE,
            "did:plc:faye",
            &authorized(),
            "1998-05-03T00:00:00.000Z",
        )
        .unwrap()
        .unwrap();

        assert_eq!(only_upsert_boundaries(&page), [BEBOP]);
        assert_eq!(
            page.interactions.upserts,
            [expected_interaction(
                REPOST,
                "two",
                FAYE_LIKE_SUBJECT,
                BEBOP
            )]
        );
        assert!(page.interactions.deletes.is_empty());
    }

    #[derive(Serialize)]
    struct CommitOfValues {
        seq: u64,
        did: &'static str,
        time: &'static str,
        rev: &'static str,
        ops: Vec<CborValue>,
    }

    fn frame_of_values(ops: Vec<CborValue>) -> Vec<u8> {
        let mut frame = serde_cbor::to_vec(&Header { kind: "#commit" }).unwrap();
        frame.extend(
            serde_cbor::to_vec(&CommitOfValues {
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

    fn with_action(operation: Operation, action: Option<CborValue>) -> CborValue {
        let CborValue::Map(mut fields) = serde_cbor::value::to_value(&operation).unwrap() else {
            unreachable!();
        };
        match action {
            Some(action) => fields.insert(text("action"), action),
            None => fields.remove(&text("action")),
        };
        CborValue::Map(fields)
    }

    fn parse_values(ops: Vec<CborValue>) -> Result<crate::store::ActorPage, ActorEventError> {
        parse_actor_commit(
            &frame_of_values(ops),
            SERVICE,
            "did:plc:faye",
            &authorized(),
            "1998-05-03T00:00:00.000Z",
        )
        .map(|page| page.unwrap())
    }

    fn valid_like(path: &'static str, collection: &str) -> Operation {
        interaction_op(
            "create",
            path,
            Some(valid_body(collection)),
            Some(boundary(&["bebop"])),
        )
    }

    #[test]
    fn a_like_or_repost_with_an_unreadable_action_is_skipped_and_the_post_beside_it_is_kept() {
        let page = parse_values(vec![
            with_action(
                create_op(record(CREATED_AT, &["bebop"]), None),
                Some(text("create")),
            ),
            with_action(
                valid_like("app.bsky.feed.like/one", LIKE),
                Some(CborValue::Integer(7)),
            ),
            with_action(valid_like("app.bsky.feed.like/two", LIKE), None),
            with_action(
                valid_like("app.bsky.feed.repost/three", REPOST),
                Some(CborValue::Null),
            ),
        ])
        .unwrap();

        assert_eq!(only_upsert_boundaries(&page), [BEBOP]);
        assert_eq!(page.interactions, InteractionChanges::default());
    }

    #[test]
    fn an_unreadable_action_outside_likes_and_reposts_still_fails_the_frame() {
        let post = || create_op(record(CREATED_AT, &["bebop"]), None);
        let follow = || valid_like("app.bsky.graph.follow/three", LIKE);
        let unreadable_actions = [Some(CborValue::Integer(7)), None, Some(CborValue::Null)];
        for action in unreadable_actions {
            for operation in [post(), follow()] {
                assert_eq!(
                    parse_values(vec![with_action(operation, action.clone())]).err(),
                    Some(ActorEventError::InvalidFrame)
                );
            }
        }
    }

    #[test]
    fn an_unreadable_path_still_fails_the_frame() {
        let CborValue::Map(mut like) = with_action(
            valid_like("app.bsky.feed.like/one", LIKE),
            Some(text("create")),
        ) else {
            unreachable!();
        };
        like.insert(text("path"), CborValue::Integer(7));

        assert_eq!(
            parse_values(vec![CborValue::Map(like)]).err(),
            Some(ActorEventError::InvalidFrame)
        );
    }

    #[test]
    fn the_last_operation_on_one_interaction_wins() {
        let page = parse_actor_commit(
            &frame(vec![
                interaction_op(
                    "create",
                    "app.bsky.feed.like/one",
                    Some(valid_body(LIKE)),
                    Some(boundary(&["bebop"])),
                ),
                interaction_op("delete", "app.bsky.feed.like/one", None, None),
            ]),
            SERVICE,
            "did:plc:faye",
            &authorized(),
            "1998-05-03T00:00:00.000Z",
        )
        .unwrap()
        .unwrap();

        assert!(page.interactions.upserts.is_empty());
        assert_eq!(page.interactions.deletes, [faye_uri(LIKE, "one")]);
    }
}

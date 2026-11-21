//! Typed operations of one `listRepoOps` page, and their pure application to a
//! set-hash state. The page body is unauthenticated until the digest of the
//! state it produces equals the `data` of a MAC-verified commit; nothing here
//! stores or projects anything.

use std::{collections::HashMap, fmt};

use cid::{Cid, Version};
use serde_json::{Map, Value};

use crate::{
    identifier::{Did, RecordUri, SpaceUri},
    space_mac::{MacVerifiedCommit, is_tid},
    space_record::{RecordRefusal, check_cid_text, encode_record, record_cid},
    space_set_hash::{RecordPath, RecordPathError, SetHashState, set_hash_element},
    space_sync::{
        MAX_CID_BYTES, MAX_CURSOR_BYTES, MAX_SPACE_PAGE_OPS, is_admitted_record,
        is_projected_collection, serialize_bounded,
    },
    space_value_budget::{BodyCountRefusal, ValueBudget, count_body_values},
    store::{SpaceStageMutation, is_utc_timestamp},
};

const DAG_CBOR_CODEC: u64 = 0x71;
const SHA2_256_CODE: u64 = 0x12;
const SHA2_256_BYTES: usize = 32;

/// One operation of a page: the record at `path` went from `prev` to `cid`.
/// A create has no `prev`, a delete no `cid`.
#[derive(Clone, Debug, PartialEq)]
pub struct RepoOp {
    rev: String,
    path: RecordPath,
    cid: Option<Cid>,
    prev: Option<Cid>,
    value: Option<Value>,
}

impl RepoOp {
    pub fn rev(&self) -> &str {
        &self.rev
    }

    pub fn path(&self) -> &RecordPath {
        &self.path
    }

    pub fn cid(&self) -> Option<&Cid> {
        self.cid.as_ref()
    }

    pub fn prev(&self) -> Option<&Cid> {
        self.prev.as_ref()
    }

    /// The record the host sent with a create or update. Always a JSON object;
    /// never present on a delete.
    pub fn value(&self) -> Option<&Value> {
        self.value.as_ref()
    }
}

impl RepoOp {
    /// A record of a complete repo state as the operation that creates it, so a
    /// whole-repo replacement goes through the code that holds a value to its
    /// CID without writing the records out as a page and reading them back.
    pub(crate) fn creating(
        rev: &str,
        path: RecordPath,
        cid: Cid,
        value: Option<Value>,
    ) -> Result<Self, OpPageRefusal> {
        if !is_tid(rev) {
            return Err(OpPageRefusal::InvalidRev);
        }
        if value.as_ref().is_some_and(|record| !record.is_object()) {
            return Err(OpPageRefusal::ValueNotAnObject);
        }
        Ok(Self {
            rev: rev.to_owned(),
            path,
            cid: Some(cid),
            prev: None,
            value,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpPage {
    ops: Vec<RepoOp>,
    cursor: Option<String>,
}

impl OpPage {
    pub fn ops(&self) -> &[RepoOp] {
        &self.ops
    }

    pub fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref()
    }

    /// The ops, so a poll that holds the ops of many pages does not copy them.
    pub fn into_ops(self) -> Vec<RepoOp> {
        self.ops
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpPageRefusal {
    NotJson,
    NotAnObject,
    OpsMissing,
    TooManyOps,
    InvalidCursor,
    OpNotAnObject,
    InvalidRev,
    InvalidPath(RecordPathError),
    InvalidCid,
    NothingChanged,
    ValueNotAnObject,
    OverBudget,
}

impl fmt::Display for OpPageRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotJson => formatter.write_str("the page is not JSON"),
            Self::NotAnObject => formatter.write_str("the page is not an object"),
            Self::OpsMissing => formatter.write_str("the page has no ops array"),
            Self::TooManyOps => formatter.write_str("the page has more operations than allowed"),
            Self::InvalidCursor => formatter.write_str("the page cursor is not usable"),
            Self::OpNotAnObject => formatter.write_str("an operation is not an object"),
            Self::InvalidRev => formatter.write_str("an operation has a rev that is not a TID"),
            Self::InvalidPath(error) => write!(formatter, "an operation has an {error}"),
            Self::InvalidCid => {
                formatter.write_str("an operation has a cid or prev that is not a canonical CID")
            }
            Self::NothingChanged => {
                formatter.write_str("an operation has neither a cid nor a prev")
            }
            Self::ValueNotAnObject => formatter.write_str("an operation's record is not an object"),
            Self::OverBudget => {
                formatter.write_str("the page would take the cycle past its decoded values")
            }
        }
    }
}

impl std::error::Error for OpPageRefusal {}

/// Reads the body of an authenticated page. The whole page is refused when any
/// operation is malformed; the body's `commit` member is not read, the verified
/// commit travels with the page. Every value of the body is charged to the
/// cycle's `budget` before the body is parsed into a tree: the ops of a poll
/// are all held until they are applied together.
pub fn decode_op_page(body: &[u8], budget: &ValueBudget) -> Result<OpPage, OpPageRefusal> {
    let values = count_body_values(body, budget.remaining()).map_err(|refusal| match refusal {
        BodyCountRefusal::NotJson => OpPageRefusal::NotJson,
        BodyCountRefusal::OverBudget => OpPageRefusal::OverBudget,
    })?;
    budget
        .charge(values)
        .map_err(|_| OpPageRefusal::OverBudget)?;
    let page: Value = serde_json::from_slice(body).map_err(|_| OpPageRefusal::NotJson)?;
    let Value::Object(page) = page else {
        return Err(OpPageRefusal::NotAnObject);
    };
    let Some(Value::Array(raw_ops)) = page.get("ops") else {
        return Err(OpPageRefusal::OpsMissing);
    };
    if raw_ops.len() > MAX_SPACE_PAGE_OPS {
        return Err(OpPageRefusal::TooManyOps);
    }
    let cursor = match page.get("cursor") {
        None => None,
        Some(Value::String(cursor)) if !cursor.is_empty() && cursor.len() <= MAX_CURSOR_BYTES => {
            Some(cursor.clone())
        }
        Some(_) => return Err(OpPageRefusal::InvalidCursor),
    };
    let ops = raw_ops
        .iter()
        .map(decode_op)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(OpPage { ops, cursor })
}

fn decode_op(raw: &Value) -> Result<RepoOp, OpPageRefusal> {
    let Value::Object(op) = raw else {
        return Err(OpPageRefusal::OpNotAnObject);
    };
    let rev = text_member(op, "rev").filter(|rev| is_tid(rev));
    let Some(rev) = rev else {
        return Err(OpPageRefusal::InvalidRev);
    };
    let collection = text_member(op, "collection").unwrap_or_default();
    let rkey = text_member(op, "rkey").unwrap_or_default();
    let path = RecordPath::parse(collection, rkey).map_err(OpPageRefusal::InvalidPath)?;
    let cid = cid_member(op, "cid")?;
    let prev = cid_member(op, "prev")?;
    if cid.is_none() && prev.is_none() {
        return Err(OpPageRefusal::NothingChanged);
    }
    let value = match (&cid, op.get("value")) {
        (Some(_), Some(Value::Object(record))) => Some(Value::Object(record.clone())),
        (Some(_), Some(_)) => return Err(OpPageRefusal::ValueNotAnObject),
        // A delete's record is never read: it is neither hashed nor projected.
        _ => None,
    };
    Ok(RepoOp {
        rev: rev.to_owned(),
        path,
        cid,
        prev,
        value,
    })
}

fn text_member<'a>(object: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    object.get(name).and_then(Value::as_str)
}

/// A member that must be present and is either null or a canonical CID text.
fn cid_member(object: &Map<String, Value>, name: &str) -> Result<Option<Cid>, OpPageRefusal> {
    match object.get(name) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => parse_record_cid(text).map(Some),
        _ => Err(OpPageRefusal::InvalidCid),
    }
}

/// A record CID is version 1, DAG-CBOR, SHA-256 and written in its canonical
/// text, as the upstream CBOR-flavored parse requires.
fn parse_record_cid(text: &str) -> Result<Cid, OpPageRefusal> {
    if text.len() > MAX_CID_BYTES {
        return Err(OpPageRefusal::InvalidCid);
    }
    let cid = Cid::try_from(text).map_err(|_| OpPageRefusal::InvalidCid)?;
    check_cid_text(text, &cid).map_err(|_| OpPageRefusal::InvalidCid)?;
    let is_record_cid = cid.version() == Version::V1
        && cid.codec() == DAG_CBOR_CODEC
        && cid.hash().code() == SHA2_256_CODE
        && cid.hash().size() as usize == SHA2_256_BYTES;
    if !is_record_cid {
        return Err(OpPageRefusal::InvalidCid);
    }
    Ok(cid)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChangeSetRefusal {
    ValueNotEncodable(RecordRefusal),
    ValueDoesNotMatchCid,
    PreviousMismatch,
}

impl fmt::Display for ChangeSetRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ValueNotEncodable(refusal) => {
                write!(
                    formatter,
                    "an operation's record cannot be encoded: {refusal}"
                )
            }
            Self::ValueDoesNotMatchCid => {
                formatter.write_str("an operation's record is not the one its cid names")
            }
            Self::PreviousMismatch => {
                formatter.write_str("an operation's prev is not what the earlier operations left")
            }
        }
    }
}

impl std::error::Error for ChangeSetRefusal {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DigestMismatch;

impl fmt::Display for DigestMismatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the state digest is not the commit's data")
    }
}

impl std::error::Error for DigestMismatch {}

/// The net effect of a run of operations on one record path.
#[derive(Clone, Debug, PartialEq)]
pub struct PathChange {
    path: RecordPath,
    expected_prev: Option<Cid>,
    cid: Option<Cid>,
    value: Option<Value>,
}

impl PathChange {
    pub fn path(&self) -> &RecordPath {
        &self.path
    }

    /// The CID the path must have held before the first operation touched it.
    pub fn expected_prev(&self) -> Option<&Cid> {
        self.expected_prev.as_ref()
    }

    /// The CID the path holds after the last operation; `None` for a delete.
    pub fn cid(&self) -> Option<&Cid> {
        self.cid.as_ref()
    }

    /// The record of the last operation when it carried one and the projection
    /// reads its collection.
    pub fn value(&self) -> Option<&Value> {
        self.value.as_ref()
    }

    /// A create or update of a record the projection reads that arrived without
    /// its record: the path changes, nothing can be projected from it. A record
    /// of another collection never keeps its value, so it is never missing one.
    pub fn value_missing(&self) -> bool {
        self.cid.is_some()
            && self.value.is_none()
            && is_projected_collection(self.path.collection())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChangeSet {
    state: SetHashState,
    changes: Vec<PathChange>,
}

impl ChangeSet {
    /// Applies `ops` in order to `base`. Ops of several pages are applied by
    /// passing them together, so a poll's net change is one change set. Every
    /// op's value is held to its CID; the change set keeps the values of the
    /// collections the projection reads and no others.
    pub fn apply(base: SetHashState, ops: &[RepoOp]) -> Result<Self, ChangeSetRefusal> {
        let mut state = base;
        let mut changes: Vec<PathChange> = Vec::new();
        let mut position: HashMap<(&str, &str), usize> = HashMap::new();
        for op in ops {
            let key = (op.path.collection(), op.path.rkey());
            let index = *position.entry(key).or_insert_with(|| {
                changes.push(PathChange {
                    path: op.path.clone(),
                    expected_prev: op.prev,
                    cid: op.prev,
                    value: None,
                });
                changes.len() - 1
            });
            let change = &mut changes[index];
            if change.cid != op.prev {
                return Err(ChangeSetRefusal::PreviousMismatch);
            }
            if let (Some(cid), Some(value)) = (&op.cid, &op.value) {
                let encoded = encode_record(value).map_err(ChangeSetRefusal::ValueNotEncodable)?;
                if &record_cid(&encoded) != cid {
                    return Err(ChangeSetRefusal::ValueDoesNotMatchCid);
                }
            }
            if let Some(prev) = &op.prev {
                state.remove(&set_hash_element(&op.path, prev));
            }
            if let Some(cid) = &op.cid {
                state.add(&set_hash_element(&op.path, cid));
            }
            change.cid = op.cid;
            // The value was held to its CID above; the digest covers the CID,
            // so a value nothing will project is not worth holding on to.
            change.value = op
                .value
                .as_ref()
                .filter(|_| is_projected_collection(op.path.collection()))
                .cloned();
        }
        Ok(Self { state, changes })
    }

    pub fn state(&self) -> &SetHashState {
        &self.state
    }

    pub fn changes(&self) -> &[PathChange] {
        &self.changes
    }

    pub fn prove(self, commit: &MacVerifiedCommit) -> Result<ProvenChangeSet, DigestMismatch> {
        if &self.state.digest() != commit.data() {
            return Err(DigestMismatch);
        }
        Ok(ProvenChangeSet {
            change_set: self,
            commit: commit.clone(),
        })
    }
}

/// A change set whose state digest equals the `data` of `commit`.
#[derive(Clone, Debug, PartialEq)]
pub struct ProvenChangeSet {
    change_set: ChangeSet,
    commit: MacVerifiedCommit,
}

impl ProvenChangeSet {
    pub fn change_set(&self) -> &ChangeSet {
        &self.change_set
    }

    pub fn commit(&self) -> &MacVerifiedCommit {
        &self.commit
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionRefusal {
    InvalidTimestamp,
    InvalidRecordUri,
}

impl fmt::Display for ProjectionRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidTimestamp => "the observation time is not a UTC timestamp",
            Self::InvalidRecordUri => "a record path does not make a record URI",
        })
    }
}

impl std::error::Error for ProjectionRefusal {}

/// The projection mutation each post, like or repost change makes, under the
/// admission and field rules of the page-by-page path. A delete, a missing
/// record and an inadmissible record all give a removal, so a replacement that
/// stops being admissible does not leave the old row served. Other collections
/// give nothing. The boundary is not part of a mutation: the store stamps the
/// target's.
pub fn projection_mutations(
    space: &SpaceUri,
    author: &Did,
    changes: &[PathChange],
    observed_at: &str,
) -> Result<Vec<SpaceStageMutation>, ProjectionRefusal> {
    if !is_utc_timestamp(observed_at) {
        return Err(ProjectionRefusal::InvalidTimestamp);
    }
    let mut mutations = Vec::new();
    for change in changes {
        let collection = change.path.collection();
        if !is_projected_collection(collection) {
            continue;
        }
        let uri = space.record_uri(author, collection, change.path.rkey());
        if !matches!(
            RecordUri::parse_space_record(&uri),
            Ok(RecordUri::Space { .. })
        ) {
            return Err(ProjectionRefusal::InvalidRecordUri);
        }
        mutations.push(match (&change.cid, &change.value) {
            (Some(cid), Some(value)) if is_admitted_record(collection, value) => {
                match serialize_bounded(value) {
                    Ok(record_json) => SpaceStageMutation::Upsert {
                        uri,
                        cid: cid.to_string(),
                        sort_at: sort_at_of(value, observed_at),
                        indexed_at: observed_at.to_owned(),
                        record_json,
                        blob_refs_json: b"[]".to_vec(),
                    },
                    Err(_) => SpaceStageMutation::Delete { uri },
                }
            }
            _ => SpaceStageMutation::Delete { uri },
        });
    }
    Ok(mutations)
}

fn sort_at_of(value: &Value, observed_at: &str) -> String {
    value
        .as_object()
        .and_then(|record| record.get("createdAt"))
        .and_then(Value::as_str)
        .filter(|created_at| is_utc_timestamp(created_at) && *created_at <= observed_at)
        .unwrap_or(observed_at)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use base64::{
        Engine,
        engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    };
    use serde_json::{Map, json};

    use super::*;
    use crate::space_record::{encode_record, record_cid};
    use crate::space_set_hash::set_hash_element;

    const OP_PAGES: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/op-pages.json");
    const SPACE: &str = "at:space/did:web:bebop.example/zone.stratos.space.feed/crew";
    const FAYE: &str = "did:plc:fayevalentine";
    const NOW: &str = "2026-09-22T00:00:00.000Z";
    const POST: &str = "zone.stratos.feed.post";
    const LIKE: &str = "app.bsky.feed.like";
    const REPOST: &str = "app.bsky.feed.repost";
    const FOLLOW: &str = "app.bsky.graph.follow";
    const SWORDFISH_CID: &str = "bafyreiblisg4mhig4cyda6j2cizhefufa7n3smi5jxdlxug3t45ztfe5pq";
    const SWORDFISH_EDITED_CID: &str =
        "bafyreia2riwiofeyueakvuobrujsfp6rovaqbfkbi5v455itkaoyxf4wii";

    fn fixture() -> Value {
        serde_json::from_str(OP_PAGES).expect("fixture is json")
    }

    fn fixture_pages() -> Vec<Value> {
        fixture()["pages"].as_array().expect("pages").clone()
    }

    fn commit_of(page: &Value) -> MacVerifiedCommit {
        let commit = &page["commit"];
        let data = STANDARD_NO_PAD
            .decode(commit["data"]["$bytes"].as_str().expect("data"))
            .expect("base64");
        MacVerifiedCommit::for_tests(
            commit["repo"].as_str().expect("repo"),
            commit["space"].as_str().expect("space"),
            commit["rev"].as_str().expect("rev"),
            data.try_into().expect("32 bytes"),
        )
    }

    fn body_of(page: &Value) -> Vec<u8> {
        serde_json::to_vec(page).expect("serializable")
    }

    fn decoded(page: &Value) -> OpPage {
        decode_op_page(&body_of(page), &ValueBudget::unlimited_for_tests())
            .expect("a well-formed page")
    }

    fn cid_of_value(value: &Value) -> Cid {
        record_cid(&encode_record(value).expect("encodable"))
    }

    fn post_value(text: &str) -> Value {
        json!({ "$type": POST, "text": text })
    }

    fn page_with(ops: Vec<Value>) -> Value {
        json!({ "ops": ops, "commit": fixture_pages()[0]["commit"].clone() })
    }

    fn op_json(
        rev: &str,
        collection: &str,
        rkey: &str,
        cid: &Value,
        prev: &Value,
    ) -> Map<String, Value> {
        let mut op = Map::new();
        op.insert("rev".into(), json!(rev));
        op.insert("collection".into(), json!(collection));
        op.insert("rkey".into(), json!(rkey));
        op.insert("cid".into(), cid.clone());
        op.insert("prev".into(), prev.clone());
        op
    }

    fn create_post(rkey: &str, value: &Value) -> Value {
        let cid = cid_of_value(value).to_string();
        let mut op = op_json("3jzfcijpj2z2a", POST, rkey, &json!(cid), &Value::Null);
        op.insert("value".into(), value.clone());
        Value::Object(op)
    }

    fn update_post(rkey: &str, prev: &Cid, value: &Value) -> Value {
        let cid = cid_of_value(value).to_string();
        let mut op = op_json(
            "3jzfcijpj2z2b",
            POST,
            rkey,
            &json!(cid),
            &json!(prev.to_string()),
        );
        op.insert("value".into(), value.clone());
        Value::Object(op)
    }

    fn ops_of(ops: Vec<Value>) -> Vec<RepoOp> {
        decoded(&page_with(ops)).ops().to_vec()
    }

    fn applied(ops: Vec<Value>) -> Result<ChangeSet, ChangeSetRefusal> {
        ChangeSet::apply(SetHashState::empty(), &ops_of(ops))
    }

    fn space() -> SpaceUri {
        SpaceUri::parse(SPACE).expect("space uri")
    }

    fn faye() -> Did {
        Did::parse(FAYE).expect("did")
    }

    fn mutations_of(set: &ChangeSet) -> Vec<SpaceStageMutation> {
        projection_mutations(&space(), &faye(), set.changes(), NOW).expect("projectable")
    }

    fn mutation_uri(mutation: &SpaceStageMutation) -> &str {
        match mutation {
            SpaceStageMutation::Upsert { uri, .. } | SpaceStageMutation::Delete { uri } => uri,
        }
    }

    fn record_uri(collection: &str, rkey: &str) -> String {
        format!("{SPACE}/{FAYE}/{collection}/{rkey}")
    }

    // Oracle vectors (op-pages.json): the oracle's RepoCommit made each commit.

    #[test]
    fn every_fixture_page_reaches_the_digest_the_oracle_committed_to() {
        let mut state = SetHashState::empty();
        let mut earlier_digest = None;
        for page in fixture_pages() {
            let change_set =
                ChangeSet::apply(state, decoded(&page).ops()).expect("fixture ops apply");
            let commit = commit_of(&page);
            let proven = change_set
                .prove(&commit)
                .expect("digest equals commit data");
            assert_eq!(proven.commit(), &commit);
            let has_ops = !page["ops"].as_array().expect("ops").is_empty();
            assert_eq!(
                earlier_digest != Some(*commit.data()),
                has_ops,
                "a page with operations moves the digest, an empty one leaves it"
            );
            earlier_digest = Some(*commit.data());
            state = proven.change_set().state().clone();
        }
        let final_state = &fixture()["stateAfterLastPage"];
        assert_eq!(
            state.to_bytes().as_slice(),
            STANDARD
                .decode(final_state["value"].as_str().expect("state"))
                .expect("base64")
        );
    }

    #[test]
    fn the_first_fixture_page_decodes_into_typed_operations() {
        let page = decoded(&fixture_pages()[0]);
        assert_eq!(page.cursor(), None);
        let first = &page.ops()[0];
        assert_eq!(first.rev(), "3jzfcijpj2z2a");
        assert_eq!(first.path().collection(), POST);
        assert_eq!(first.path().rkey(), "swordfish");
        assert_eq!(
            first.cid().map(ToString::to_string).as_deref(),
            Some(SWORDFISH_CID)
        );
        assert_eq!(first.prev(), None);
        assert_eq!(first.value(), Some(&post_value("See you space cowboy")));
        let second = &page.ops()[1];
        assert_eq!(
            second.prev().map(ToString::to_string).as_deref(),
            Some(SWORDFISH_CID)
        );
        assert_eq!(page.ops().len(), 5);
    }

    #[test]
    fn the_fixture_delete_has_no_cid_and_no_value() {
        let page = decoded(&fixture_pages()[1]);
        let delete = &page.ops()[1];
        assert_eq!(delete.cid(), None);
        assert!(delete.prev().is_some());
        assert_eq!(delete.value(), None);
    }

    // Wire-format edge table. The oracle column is the upstream lexicon shape of
    // `com.atproto.space.listRepoOps` run through the pinned package's
    // lex-schema, then `RepoCommit.applyOps` on the parsed ids (edge probe:
    // `edge.mjs`, output `edge-output.json`). Upstream has no incremental op
    // consumer, so nothing upstream checks a value against its cid, a `prev`
    // against earlier operations or a rev order. Where this decoder's verdict
    // differs from the oracle's, the row says why.

    enum Oracle {
        Accepts(Option<&'static str>),
        Refuses(&'static str),
    }

    enum Verdict {
        Accepts,
        RefusesPage(OpPageRefusal),
        RefusesChangeSet(ChangeSetRefusal),
    }

    struct Row {
        name: &'static str,
        body: Value,
        oracle: Oracle,
        verdict: Verdict,
        differs_because: Option<&'static str>,
    }

    fn base_op() -> Map<String, Value> {
        let mut op = op_json(
            "3jzfcijpj2z2a",
            POST,
            "swordfish",
            &json!(SWORDFISH_CID),
            &Value::Null,
        );
        op.insert("value".into(), post_value("See you space cowboy"));
        op
    }

    fn base_op_with(changes: &[(&str, Value)]) -> Value {
        let mut op = base_op();
        for (key, value) in changes {
            op.insert((*key).to_owned(), value.clone());
        }
        Value::Object(op)
    }

    fn base_op_without(key: &str) -> Value {
        let mut op = base_op();
        op.remove(key);
        Value::Object(op)
    }

    fn deletion() -> Value {
        let mut op = base_op();
        op.remove("value");
        op.insert("cid".into(), Value::Null);
        op.insert("prev".into(), json!(SWORDFISH_CID));
        Value::Object(op)
    }

    fn edit() -> Value {
        base_op_with(&[
            ("rev", json!("3jzfcijpj2z2b")),
            ("cid", json!(SWORDFISH_EDITED_CID)),
            ("prev", json!(SWORDFISH_CID)),
            ("value", post_value("See you space cowboy, edited")),
        ])
    }

    fn edge_rows() -> Vec<Row> {
        let commit = fixture_pages()[0]["commit"].clone();
        let page = |ops: Vec<Value>| json!({ "ops": ops, "commit": commit.clone() });
        let page_with_extra = |ops: Vec<Value>, key: &str, value: Value| {
            let mut page = page(ops);
            page[key] = value;
            page
        };
        let refused_by_lexicon = |reason| Oracle::Refuses(reason);
        vec![
            Row {
                name: "cid absent",
                body: page(vec![base_op_without("cid")]),
                oracle: refused_by_lexicon("missing required key cid"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCid),
                differs_because: None,
            },
            Row {
                name: "cid null and value absent (a delete)",
                body: page(vec![deletion()]),
                oracle: Oracle::Accepts(Some("19ea34ea13fec10d")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
            Row {
                name: "prev absent",
                body: page(vec![base_op_without("prev")]),
                oracle: refused_by_lexicon("missing required key prev"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCid),
                differs_because: None,
            },
            Row {
                name: "prev null (a create)",
                body: page(vec![base_op_with(&[])]),
                oracle: Oracle::Accepts(Some("c939b5ca4843b4d3")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
            Row {
                name: "cid and prev both null",
                body: page(vec![base_op_with(&[
                    ("cid", Value::Null),
                    ("value", Value::Null),
                ])]),
                oracle: Oracle::Accepts(Some("e5a00aa9991ac8a5")),
                verdict: Verdict::RefusesPage(OpPageRefusal::NothingChanged),
                differs_because: Some("an operation that changes nothing is a host defect"),
            },
            Row {
                name: "value absent on a create",
                body: page(vec![base_op_without("value")]),
                oracle: Oracle::Accepts(Some("c939b5ca4843b4d3")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
            Row {
                name: "value present on a delete",
                body: page(vec![base_op_with(&[
                    ("cid", Value::Null),
                    ("prev", json!(SWORDFISH_CID)),
                ])]),
                oracle: Oracle::Accepts(Some("19ea34ea13fec10d")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
            Row {
                name: "value null on a create",
                body: page(vec![base_op_with(&[("value", Value::Null)])]),
                oracle: Oracle::Accepts(Some("c939b5ca4843b4d3")),
                verdict: Verdict::RefusesPage(OpPageRefusal::ValueNotAnObject),
                differs_because: Some("a record is a JSON object"),
            },
            Row {
                name: "value a string on a create",
                body: page(vec![base_op_with(&[("value", json!("See you"))])]),
                oracle: Oracle::Accepts(Some("c939b5ca4843b4d3")),
                verdict: Verdict::RefusesPage(OpPageRefusal::ValueNotAnObject),
                differs_because: Some("a record is a JSON object"),
            },
            Row {
                name: "value an array on a create",
                body: page(vec![base_op_with(&[("value", json!([1]))])]),
                oracle: Oracle::Accepts(Some("c939b5ca4843b4d3")),
                verdict: Verdict::RefusesPage(OpPageRefusal::ValueNotAnObject),
                differs_because: Some("a record is a JSON object"),
            },
            Row {
                name: "unknown extra member on an op",
                body: page(vec![base_op_with(&[("mood", json!("blue"))])]),
                oracle: Oracle::Accepts(Some("c939b5ca4843b4d3")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
            Row {
                name: "unknown extra member on the page",
                body: page_with_extra(vec![base_op_with(&[])], "extra", json!(1)),
                oracle: Oracle::Accepts(Some("c939b5ca4843b4d3")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
            Row {
                name: "rev not a TID",
                body: page(vec![base_op_with(&[("rev", json!("not-a-tid"))])]),
                oracle: refused_by_lexicon("invalid TID"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidRev),
                differs_because: None,
            },
            Row {
                name: "collection not an NSID",
                body: page(vec![base_op_with(&[("collection", json!("feed"))])]),
                oracle: refused_by_lexicon("invalid NSID"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidPath(
                    RecordPathError::InvalidCollection,
                )),
                differs_because: None,
            },
            Row {
                name: "rkey with a slash",
                body: page(vec![base_op_with(&[("rkey", json!("a/b"))])]),
                oracle: refused_by_lexicon("invalid record key"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidPath(
                    RecordPathError::InvalidRecordKey,
                )),
                differs_because: None,
            },
            Row {
                name: "rkey is two dots",
                body: page(vec![base_op_with(&[("rkey", json!(".."))])]),
                oracle: refused_by_lexicon("invalid record key"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidPath(
                    RecordPathError::InvalidRecordKey,
                )),
                differs_because: None,
            },
            Row {
                name: "cid a number",
                body: page(vec![base_op_with(&[("cid", json!(5))])]),
                oracle: refused_by_lexicon("expected string"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCid),
                differs_because: None,
            },
            Row {
                name: "cid not a CID string",
                body: page(vec![base_op_with(&[("cid", json!("hello"))])]),
                oracle: refused_by_lexicon("invalid CID string"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCid),
                differs_because: None,
            },
            Row {
                name: "cid in upper-case base32 (not canonical text)",
                body: page(vec![base_op_with(&[(
                    "cid",
                    json!(SWORDFISH_CID.to_uppercase()),
                )])]),
                oracle: refused_by_lexicon("invalid CID string"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCid),
                differs_because: None,
            },
            Row {
                name: "cid a version 0 CID",
                body: page(vec![base_op_with(&[(
                    "cid",
                    json!("QmZULkCELmmk5XNfCgHnfH6HVDRFYhvkE2kAhLUJ95qAHo"),
                )])]),
                oracle: refused_by_lexicon(
                    "the lexicon accepts it; the cbor-flavor CID parse refuses it",
                ),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCid),
                differs_because: None,
            },
            Row {
                name: "cid a raw-codec CID",
                body: page(vec![base_op_with(&[(
                    "cid",
                    json!("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"),
                )])]),
                oracle: refused_by_lexicon(
                    "the lexicon accepts it; the cbor-flavor CID parse refuses it",
                ),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCid),
                differs_because: None,
            },
            Row {
                name: "cid longer than 256 bytes",
                body: page(vec![base_op_with(&[(
                    "cid",
                    json!(format!("{SWORDFISH_CID}{}", "a".repeat(300))),
                )])]),
                oracle: refused_by_lexicon("invalid CID string"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCid),
                differs_because: None,
            },
            Row {
                name: "prev not a CID string",
                body: page(vec![base_op_with(&[("prev", json!("hello"))])]),
                oracle: refused_by_lexicon("invalid CID string"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCid),
                differs_because: None,
            },
            Row {
                name: "cid is not the CID of the value",
                body: page(vec![base_op_with(&[("cid", json!(SWORDFISH_EDITED_CID))])]),
                oracle: Oracle::Accepts(Some("17c4c807d4daf388")),
                verdict: Verdict::RefusesChangeSet(ChangeSetRefusal::ValueDoesNotMatchCid),
                differs_because: Some(
                    "the oracle checks no operation's value; a value must be the record its cid names",
                ),
            },
            Row {
                name: "two operations on one path in one page, chained",
                body: page(vec![base_op_with(&[]), edit()]),
                oracle: Oracle::Accepts(Some("17c4c807d4daf388")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
            Row {
                name: "two operations on one path, the second prev is not the first cid",
                body: page(vec![
                    base_op_with(&[]),
                    base_op_with(&[
                        ("rev", json!("3jzfcijpj2z2b")),
                        ("cid", json!(SWORDFISH_EDITED_CID)),
                        ("prev", json!(SWORDFISH_EDITED_CID)),
                        ("value", post_value("See you space cowboy, edited")),
                    ]),
                ]),
                oracle: Oracle::Accepts(Some("c939b5ca4843b4d3")),
                verdict: Verdict::RefusesChangeSet(ChangeSetRefusal::PreviousMismatch),
                differs_because: Some(
                    "the oracle applies prev blindly; a prev must be what the set last gave the path",
                ),
            },
            Row {
                name: "revs out of order",
                body: page(vec![
                    base_op_with(&[("rev", json!("3jzfcijpj2z2b")), ("rkey", json!("a"))]),
                    base_op_with(&[("rev", json!("3jzfcijpj2z2a")), ("rkey", json!("b"))]),
                ]),
                oracle: Oracle::Accepts(Some("7b4b7e1915024a98")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
            Row {
                name: "revs equal",
                body: page(vec![
                    base_op_with(&[("rkey", json!("a"))]),
                    base_op_with(&[("rkey", json!("b"))]),
                ]),
                oracle: Oracle::Accepts(Some("7b4b7e1915024a98")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
            Row {
                name: "empty ops",
                body: page(vec![]),
                oracle: Oracle::Accepts(Some("e5a00aa9991ac8a5")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
            Row {
                name: "commit missing",
                body: json!({ "ops": [base_op_with(&[])] }),
                oracle: refused_by_lexicon("missing required key commit"),
                verdict: Verdict::Accepts,
                differs_because: Some(
                    "the body's commit is not read here; the page carries the commit the MAC verified",
                ),
            },
            Row {
                name: "commit null",
                body: json!({ "ops": [base_op_with(&[])], "commit": null }),
                oracle: refused_by_lexicon("expected object"),
                verdict: Verdict::Accepts,
                differs_because: Some(
                    "the body's commit is not read here; the page carries the commit the MAC verified",
                ),
            },
            Row {
                name: "ops missing",
                body: json!({ "commit": commit.clone() }),
                oracle: refused_by_lexicon("missing required key ops"),
                verdict: Verdict::RefusesPage(OpPageRefusal::OpsMissing),
                differs_because: None,
            },
            Row {
                name: "ops not an array",
                body: json!({ "ops": "x", "commit": commit.clone() }),
                oracle: refused_by_lexicon("expected array"),
                verdict: Verdict::RefusesPage(OpPageRefusal::OpsMissing),
                differs_because: None,
            },
            Row {
                name: "an operation that is not an object",
                body: page(vec![json!(5)]),
                oracle: refused_by_lexicon("expected object"),
                verdict: Verdict::RefusesPage(OpPageRefusal::OpNotAnObject),
                differs_because: None,
            },
            Row {
                name: "cursor a number",
                body: page_with_extra(vec![base_op_with(&[])], "cursor", json!(7)),
                oracle: refused_by_lexicon("expected string"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCursor),
                differs_because: None,
            },
            Row {
                name: "cursor null",
                body: page_with_extra(vec![base_op_with(&[])], "cursor", Value::Null),
                oracle: refused_by_lexicon("expected string"),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCursor),
                differs_because: None,
            },
            Row {
                name: "cursor empty",
                body: page_with_extra(vec![base_op_with(&[])], "cursor", json!("")),
                oracle: Oracle::Accepts(Some("c939b5ca4843b4d3")),
                verdict: Verdict::RefusesPage(OpPageRefusal::InvalidCursor),
                differs_because: Some(
                    "an empty cursor cannot be sent back; the earlier decoder also refuses it",
                ),
            },
            Row {
                name: "cursor a string",
                body: page_with_extra(vec![base_op_with(&[])], "cursor", json!("3jzfcijpj2z2a/0")),
                oracle: Oracle::Accepts(Some("c939b5ca4843b4d3")),
                verdict: Verdict::Accepts,
                differs_because: None,
            },
        ]
    }

    fn digest_prefix(state: &SetHashState) -> String {
        state.digest()[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[test]
    fn each_wire_edge_input_gets_the_recorded_verdict() {
        let rows = edge_rows();
        assert_eq!(rows.len(), 38);
        let mut labelled = 0;
        for row in rows {
            let body = body_of(&row.body);
            let outcome = decode_op_page(&body, &ValueBudget::unlimited_for_tests())
                .map_err(Ok)
                .and_then(|page| ChangeSet::apply(SetHashState::empty(), page.ops()).map_err(Err));
            let oracle_accepts = matches!(row.oracle, Oracle::Accepts(_));
            let rust_accepts = outcome.is_ok();
            match (&row.verdict, &outcome) {
                (Verdict::Accepts, Ok(_)) => {}
                (Verdict::RefusesPage(expected), Err(Ok(found))) => {
                    assert_eq!(found, expected, "{}", row.name)
                }
                (Verdict::RefusesChangeSet(expected), Err(Err(found))) => {
                    assert_eq!(found, expected, "{}", row.name)
                }
                _ => panic!("{}: unexpected outcome {:?}", row.name, outcome.is_ok()),
            }
            assert_eq!(
                oracle_accepts != rust_accepts,
                row.differs_because.is_some(),
                "{}: a verdict that differs from the oracle's ({}) must say why, and only then",
                row.name,
                match &row.oracle {
                    Oracle::Accepts(_) => "accepts",
                    Oracle::Refuses(reason) => reason,
                }
            );
            labelled += usize::from(row.differs_because.is_some());
            if let (Oracle::Accepts(Some(digest)), Ok(set)) = (&row.oracle, &outcome) {
                assert_eq!(&digest_prefix(set.state()), digest, "{}", row.name);
            }
        }
        assert_eq!(labelled, 9);
    }

    #[test]
    fn a_body_that_is_not_a_json_object_is_refused() {
        assert_eq!(
            decode_op_page(b"{", &ValueBudget::unlimited_for_tests()),
            Err(OpPageRefusal::NotJson)
        );
        assert_eq!(
            decode_op_page(b"[]", &ValueBudget::unlimited_for_tests()),
            Err(OpPageRefusal::NotAnObject)
        );
    }

    #[test]
    fn the_operation_and_cursor_bounds_are_the_synchronizers() {
        let op = base_op_with(&[]);
        let at_limit = page_with(vec![op.clone(); crate::space_sync::MAX_SPACE_PAGE_OPS]);
        assert_eq!(decoded(&at_limit).ops().len(), 1_000);
        let over_limit = page_with(vec![op.clone(); crate::space_sync::MAX_SPACE_PAGE_OPS + 1]);
        assert_eq!(
            decode_op_page(&body_of(&over_limit), &ValueBudget::unlimited_for_tests()),
            Err(OpPageRefusal::TooManyOps)
        );
        let mut long_cursor = page_with(vec![op.clone()]);
        long_cursor["cursor"] = json!("c".repeat(crate::space_sync::MAX_CURSOR_BYTES));
        assert!(
            decode_op_page(&body_of(&long_cursor), &ValueBudget::unlimited_for_tests()).is_ok()
        );
        long_cursor["cursor"] = json!("c".repeat(crate::space_sync::MAX_CURSOR_BYTES + 1));
        assert_eq!(
            decode_op_page(&body_of(&long_cursor), &ValueBudget::unlimited_for_tests()),
            Err(OpPageRefusal::InvalidCursor)
        );
    }

    #[test]
    fn one_malformed_operation_refuses_the_whole_page() {
        let page = page_with(vec![
            base_op_with(&[]),
            base_op_with(&[("rkey", json!("a/b"))]),
        ]);
        assert!(matches!(
            decode_op_page(&body_of(&page), &ValueBudget::unlimited_for_tests()),
            Err(OpPageRefusal::InvalidPath(_))
        ));
    }

    // Cross-check: a plain map rebuilt from scratch and hashed from scratch.

    struct SeededRng(u64);

    impl SeededRng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, bound: usize) -> usize {
            usize::try_from(self.next() % u64::try_from(bound).expect("small bound")).expect("fits")
        }
    }

    const MODEL_PATHS: [(&str, &str); 5] = [
        (POST, "rei"),
        (POST, "asuka"),
        (LIKE, "shinji"),
        (REPOST, "misato"),
        (FOLLOW, "kaworu"),
    ];

    fn model_value(collection: &str, variant: usize) -> Value {
        json!({ "$type": collection, "text": format!("Tokyo-3 report {variant}") })
    }

    fn hashed_from_scratch(map: &std::collections::BTreeMap<(&str, &str), Cid>) -> SetHashState {
        let mut state = SetHashState::empty();
        for ((collection, rkey), cid) in map {
            let path = RecordPath::parse(collection, rkey).expect("valid path");
            state.add(&set_hash_element(&path, cid));
        }
        state
    }

    #[test]
    fn three_hundred_seeded_op_sequences_match_a_map_hashed_from_scratch() {
        let mut rng = SeededRng(0x9e37_79b9_7f4a_7c15);
        for round in 0..300 {
            let mut model = std::collections::BTreeMap::new();
            for path in MODEL_PATHS {
                if rng.below(2) == 0 {
                    let value = model_value(path.0, rng.below(6));
                    model.insert(path, cid_of_value(&value));
                }
            }
            let initial = model.clone();
            let base = hashed_from_scratch(&initial);
            let mut first_touched: Vec<(&str, &str)> = Vec::new();
            let mut ops = Vec::new();
            for _ in 0..rng.below(13) {
                let path = MODEL_PATHS[rng.below(MODEL_PATHS.len())];
                let previous = model.get(&path).cloned();
                let delete = previous.is_some() && rng.below(3) == 0;
                let mut op = op_json(
                    "3jzfcijpj2z2a",
                    path.0,
                    path.1,
                    &Value::Null,
                    &previous
                        .as_ref()
                        .map_or(Value::Null, |cid| json!(cid.to_string())),
                );
                if delete {
                    model.remove(&path);
                } else {
                    let value = model_value(path.0, rng.below(6));
                    let cid = cid_of_value(&value);
                    op.insert("cid".into(), json!(cid.to_string()));
                    if rng.below(4) != 0 {
                        op.insert("value".into(), value);
                    }
                    model.insert(path, cid);
                }
                if !first_touched.contains(&path) {
                    first_touched.push(path);
                }
                ops.push(Value::Object(op));
            }
            let change_set = ChangeSet::apply(base, &ops_of(ops)).expect("consistent ops apply");
            let expected = hashed_from_scratch(&model);
            assert_eq!(change_set.state(), &expected, "round {round}");
            assert_eq!(
                change_set.changes().len(),
                first_touched.len(),
                "round {round}"
            );
            for (change, path) in change_set.changes().iter().zip(&first_touched) {
                assert_eq!(
                    (change.path().collection(), change.path().rkey()),
                    *path,
                    "round {round}: net changes keep the order of first touch"
                );
                assert_eq!(change.expected_prev(), initial.get(path), "round {round}");
                assert_eq!(change.cid(), model.get(path), "round {round}");
            }
            let commit =
                MacVerifiedCommit::for_tests(FAYE, SPACE, "3jzfcijpj2z2a", expected.digest());
            assert!(change_set.prove(&commit).is_ok(), "round {round}");
        }
    }

    #[test]
    fn omitting_the_operation_of_a_record_that_is_not_projected_fails_the_digest_check() {
        let first_page = fixture_pages()[0].clone();
        let commit = commit_of(&first_page);
        let all =
            ChangeSet::apply(SetHashState::empty(), decoded(&first_page).ops()).expect("applies");
        assert!(all.prove(&commit).is_ok());

        let mut without_follow = first_page.clone();
        let ops = without_follow["ops"].as_array_mut().expect("ops");
        ops.retain(|op| op["collection"] != FOLLOW);
        assert_eq!(ops.len(), 4);
        let partial = ChangeSet::apply(SetHashState::empty(), decoded(&without_follow).ops())
            .expect("applies");
        assert_eq!(partial.prove(&commit), Err(DigestMismatch));
    }

    #[test]
    fn a_value_whose_cid_is_not_the_stated_cid_is_refused() {
        let mut op = create_post("swordfish", &post_value("See you space cowboy"));
        op["value"] = post_value("See you space cowboy, edited");
        assert_eq!(
            applied(vec![op]),
            Err(ChangeSetRefusal::ValueDoesNotMatchCid)
        );
    }

    #[test]
    fn a_value_the_encoder_refuses_refuses_the_set() {
        let value = json!({ "$type": POST, "weight": 1.5 });
        let mut op = create_post("swordfish", &post_value("See you space cowboy"));
        op["value"] = value;
        assert_eq!(
            applied(vec![op]),
            Err(ChangeSetRefusal::ValueNotEncodable(
                RecordRefusal::NumberNotAnInteger
            ))
        );
    }

    // The CID a decoder that ignores padding gives the short-padded thumb, as
    // Node's upstream reader does; a runtime with Uint8Array.fromBase64 reads
    // a plain map there and gives another.
    const SHORT_PADDED_THUMB_CID: &str =
        "bafyreiguhlxyybpe6ql2ocvo3qm4kjsxjrmluppm2kss7z2nefpvn36nt4";

    #[test]
    fn a_value_with_short_base64_padding_is_refused_even_with_the_cid_it_once_had() {
        let thumb =
            |text: &str| json!({ "$type": POST, "text": "Ein", "thumb": { "$bytes": text } });
        let mut op = create_post("data-dog", &thumb("AQ=="));
        assert_eq!(op["cid"], SHORT_PADDED_THUMB_CID);
        op["value"] = thumb("AQ=");
        assert_eq!(
            applied(vec![op]),
            Err(ChangeSetRefusal::ValueNotEncodable(
                RecordRefusal::InvalidBytes
            ))
        );
    }

    #[test]
    fn an_update_whose_prev_disagrees_with_the_set_is_refused() {
        let first = post_value("See you space cowboy");
        let wrong_prev = cid_of_value(&post_value("Bang"));
        let second = post_value("See you space cowboy, edited");
        assert_eq!(
            applied(vec![
                create_post("swordfish", &first),
                update_post("swordfish", &wrong_prev, &second),
            ]),
            Err(ChangeSetRefusal::PreviousMismatch)
        );
        let set = applied(vec![
            create_post("swordfish", &first),
            update_post("swordfish", &cid_of_value(&first), &second),
        ])
        .expect("a chained update applies");
        assert_eq!(set.changes().len(), 1);
        let change = &set.changes()[0];
        assert_eq!(change.expected_prev(), None);
        assert_eq!(change.cid(), Some(&cid_of_value(&second)));
        assert_eq!(change.value(), Some(&second));
    }

    #[test]
    fn the_first_expected_prev_is_what_the_first_operation_on_the_path_stated() {
        let first = post_value("See you space cowboy");
        let second = post_value("See you space cowboy, edited");
        let set = applied(vec![update_post(
            "swordfish",
            &cid_of_value(&first),
            &second,
        )])
        .expect("the base is not known here");
        assert_eq!(
            set.changes()[0].expected_prev(),
            Some(&cid_of_value(&first))
        );
    }

    #[test]
    fn a_create_then_a_delete_nets_to_a_path_that_was_never_there() {
        let value = post_value("See you space cowboy");
        let cid = cid_of_value(&value);
        let delete = Value::Object(op_json(
            "3jzfcijpj2z2b",
            POST,
            "swordfish",
            &Value::Null,
            &json!(cid.to_string()),
        ));
        let set = applied(vec![create_post("swordfish", &value), delete]).expect("applies");
        assert_eq!(set.state(), &SetHashState::empty());
        assert_eq!(set.changes()[0].expected_prev(), None);
        assert_eq!(set.changes()[0].cid(), None);
    }

    #[test]
    fn a_create_after_a_delete_in_one_set_must_state_no_prev() {
        let value = post_value("See you space cowboy");
        let cid = cid_of_value(&value);
        let delete = Value::Object(op_json(
            "3jzfcijpj2z2b",
            POST,
            "swordfish",
            &Value::Null,
            &json!(cid.to_string()),
        ));
        let stale_recreate = update_post("swordfish", &cid, &value);
        assert_eq!(
            applied(vec![
                create_post("swordfish", &value),
                delete.clone(),
                stale_recreate
            ]),
            Err(ChangeSetRefusal::PreviousMismatch)
        );
        let recreate = create_post("swordfish", &value);
        assert!(applied(vec![create_post("swordfish", &value), delete, recreate]).is_ok());
    }

    // Projection of the net changes.

    #[test]
    fn a_post_like_and_repost_project_with_the_targets_uris_and_the_observed_time() {
        let set = ChangeSet::apply(SetHashState::empty(), decoded(&fixture_pages()[0]).ops())
            .expect("applies");
        let mutations = mutations_of(&set);
        let uris: Vec<&str> = mutations.iter().map(mutation_uri).collect();
        assert_eq!(
            uris,
            vec![
                record_uri(POST, "swordfish"),
                record_uri(LIKE, "ed"),
                record_uri(REPOST, "jet"),
            ]
        );
        let SpaceStageMutation::Upsert {
            cid,
            sort_at,
            indexed_at,
            record_json,
            blob_refs_json,
            ..
        } = &mutations[0]
        else {
            panic!("the post projects");
        };
        assert_eq!(cid, SWORDFISH_EDITED_CID);
        assert_eq!(sort_at, NOW);
        assert_eq!(indexed_at, NOW);
        assert_eq!(
            serde_json::from_slice::<Value>(record_json).expect("json"),
            post_value("See you space cowboy, edited")
        );
        assert_eq!(blob_refs_json, b"[]");
    }

    #[test]
    fn a_created_at_in_the_past_orders_the_post_and_one_in_the_future_is_clamped() {
        let past = json!({ "$type": POST, "createdAt": "2026-09-21T00:00:00.000Z" });
        let future = json!({ "$type": POST, "createdAt": "2026-10-01T00:00:00.000Z" });
        let set =
            applied(vec![create_post("a", &past), create_post("b", &future)]).expect("applies");
        let mutations = mutations_of(&set);
        let sort_ats: Vec<&str> = mutations
            .iter()
            .map(|mutation| match mutation {
                SpaceStageMutation::Upsert { sort_at, .. } => sort_at.as_str(),
                SpaceStageMutation::Delete { .. } => panic!("both project"),
            })
            .collect();
        assert_eq!(sort_ats, vec!["2026-09-21T00:00:00.000Z", NOW]);
    }

    #[test]
    fn a_collection_that_is_not_projected_gives_no_mutation() {
        let set = applied(vec![Value::Object(base_follow())]).expect("applies");
        assert_eq!(set.changes().len(), 1);
        assert!(mutations_of(&set).is_empty());
    }

    fn base_follow() -> Map<String, Value> {
        let value = json!({ "$type": FOLLOW, "subject": "did:plc:jetblack" });
        let mut op = op_json(
            "3jzfcijpj2z2a",
            FOLLOW,
            "faye",
            &json!(cid_of_value(&value).to_string()),
            &Value::Null,
        );
        op.insert("value".into(), value);
        op
    }

    #[test]
    fn an_inadmissible_replacement_of_a_post_gives_a_removal() {
        let admitted = post_value("See you space cowboy");
        let impostor = json!({ "$type": "app.bsky.feed.post", "text": "See you space cowboy" });
        let set = applied(vec![
            create_post("swordfish", &admitted),
            update_post("swordfish", &cid_of_value(&admitted), &impostor),
        ])
        .expect("applies");
        let mutations = mutations_of(&set);
        assert!(matches!(
            mutations.as_slice(),
            [SpaceStageMutation::Delete { uri }] if uri == &record_uri(POST, "swordfish")
        ));
    }

    #[test]
    fn a_like_without_a_usable_subject_gives_a_removal() {
        let value = json!({ "$type": LIKE, "subject": { "uri": "not a uri" } });
        let cid = cid_of_value(&value).to_string();
        let mut op = op_json("3jzfcijpj2z2a", LIKE, "ed", &json!(cid), &Value::Null);
        op.insert("value".into(), value);
        let set = applied(vec![Value::Object(op)]).expect("applies");
        assert!(matches!(
            mutations_of(&set).as_slice(),
            [SpaceStageMutation::Delete { uri }] if uri == &record_uri(LIKE, "ed")
        ));
    }

    #[test]
    fn a_missing_value_and_a_delete_give_removals() {
        let value = post_value("See you space cowboy");
        let cid = cid_of_value(&value);
        let mut without_value = create_post("a", &value);
        without_value
            .as_object_mut()
            .expect("object")
            .remove("value");
        let delete = Value::Object(op_json(
            "3jzfcijpj2z2b",
            POST,
            "b",
            &Value::Null,
            &json!(cid.to_string()),
        ));
        let set = applied(vec![without_value, delete]).expect("applies");
        assert!(set.changes()[0].value_missing());
        assert!(!set.changes()[1].value_missing());
        let mutations = mutations_of(&set);
        assert!(matches!(
            mutations.as_slice(),
            [SpaceStageMutation::Delete { uri: first }, SpaceStageMutation::Delete { uri: second }]
                if first == &record_uri(POST, "a") && second == &record_uri(POST, "b")
        ));
    }

    #[test]
    fn a_post_too_large_for_the_projection_gives_a_removal() {
        let large = json!({
            "$type": POST,
            "text": "x".repeat(crate::space_sync::MAX_SPACE_RECORD_BYTES)
        });
        let set = applied(vec![create_post("swordfish", &large)]).expect("applies");
        assert!(matches!(
            mutations_of(&set).as_slice(),
            [SpaceStageMutation::Delete { .. }]
        ));
    }

    #[test]
    fn the_record_uri_follows_the_target_and_an_unusable_time_is_refused() {
        let set = applied(vec![create_post("swordfish", &post_value("Bang"))]).expect("applies");
        assert_eq!(
            projection_mutations(&space(), &faye(), set.changes(), "yesterday").err(),
            Some(ProjectionRefusal::InvalidTimestamp)
        );
        let jet = Did::parse("did:plc:jetblack").expect("did");
        let mutations = projection_mutations(&space(), &jet, set.changes(), NOW).expect("ok");
        assert_eq!(
            mutation_uri(&mutations[0]),
            format!("{SPACE}/did:plc:jetblack/{POST}/swordfish")
        );
    }

    fn create_in(collection: &str, rkey: &str, value: &Value) -> Value {
        let cid = cid_of_value(value).to_string();
        let mut op = op_json("3jzfcijpj2z2a", collection, rkey, &json!(cid), &Value::Null);
        op.insert("value".into(), value.clone());
        Value::Object(op)
    }

    fn spike_follow() -> Value {
        json!({ "$type": FOLLOW, "subject": "did:plc:spikespiegel" })
    }

    #[test]
    fn a_page_is_charged_every_value_of_its_body_and_the_body_at_the_limit_is_accepted() {
        let page = page_with(vec![create_post("swordfish", &post_value("Bang"))]);
        let values = crate::space_value_budget::count_values(&page);

        let exact = ValueBudget::with_limit(values);
        assert!(decode_op_page(&body_of(&page), &exact).is_ok());
        assert_eq!(exact.used(), values);

        let short = ValueBudget::with_limit(values - 1);
        assert_eq!(
            decode_op_page(&body_of(&page), &short),
            Err(OpPageRefusal::OverBudget)
        );
        assert_eq!(short.used(), 0);
    }

    #[test]
    fn a_page_over_the_budget_is_refused_before_it_is_parsed() {
        // Not JSON after the values that already pass the limit.
        let budget = ValueBudget::with_limit(2);
        assert_eq!(
            decode_op_page(br#"{"ops":[1,2,3,}"#, &budget),
            Err(OpPageRefusal::OverBudget)
        );
        assert_eq!(budget.used(), 0);
    }

    #[test]
    fn pages_of_one_cycle_draw_on_the_same_budget() {
        let page = page_with(vec![create_post("swordfish", &post_value("Bang"))]);
        let values = crate::space_value_budget::count_values(&page);
        let budget = ValueBudget::with_limit(values * 2);
        assert!(decode_op_page(&body_of(&page), &budget).is_ok());
        assert!(decode_op_page(&body_of(&page), &budget).is_ok());
        assert_eq!(
            decode_op_page(&body_of(&page), &budget),
            Err(OpPageRefusal::OverBudget)
        );
        assert_eq!(budget.used(), values * 2);
    }

    #[test]
    fn the_change_set_keeps_no_value_for_a_record_the_projection_does_not_read() {
        let set = applied(vec![
            create_in(FOLLOW, "spike", &spike_follow()),
            create_post("swordfish", &post_value("Bang")),
            create_in(
                LIKE,
                "ed",
                &json!({ "$type": LIKE, "subject": { "uri": "at://did:plc:fayevalentine/zone.stratos.feed.post/swordfish" } }),
            ),
        ])
        .expect("applies");
        let kept: Vec<(&str, bool)> = set
            .changes()
            .iter()
            .map(|change| (change.path().collection(), change.value().is_some()))
            .collect();
        assert_eq!(kept, vec![(FOLLOW, false), (POST, true), (LIKE, true)]);
        // The path and its CID are what the digest covers, and they stay.
        assert_eq!(
            set.changes()[0].cid().copied(),
            Some(cid_of_value(&spike_follow()))
        );
        assert!(set.changes().iter().all(|change| !change.value_missing()));
    }

    #[test]
    fn a_value_of_a_record_the_projection_does_not_read_is_still_held_to_its_cid() {
        let mut op = create_in(FOLLOW, "spike", &spike_follow());
        op["value"] = json!({ "$type": FOLLOW, "subject": "did:plc:jetblack" });
        assert_eq!(
            applied(vec![op]).err(),
            Some(ChangeSetRefusal::ValueDoesNotMatchCid)
        );
    }

    #[test]
    fn a_like_or_a_repost_without_its_value_is_a_missing_value_as_a_post_is() {
        for collection in [POST, LIKE, REPOST] {
            let value = json!({ "$type": collection });
            let mut op = create_in(collection, "ein", &value);
            op.as_object_mut().expect("object").remove("value");
            let set = applied(vec![op]).expect("applies");
            assert!(set.changes()[0].value_missing(), "{collection}");
        }
        let value = spike_follow();
        let mut follow = create_in(FOLLOW, "spike", &value);
        follow.as_object_mut().expect("object").remove("value");
        let set = applied(vec![follow]).expect("applies");
        assert!(!set.changes()[0].value_missing());
    }

    // Cross-check: the state and digest Stratos reaches after a fixed run of
    // operations over the three fixed records; the upstream package applies the
    // same run in the fixture and must reach the same bytes.

    const CROSS_CHECK_STATE_BASE64: &str = "2XO4rvh6d7V4ZV4CtsHfVcg6/kIzVMnH7bhxDYhWIMcRTGeXScVudsEkxLtUQklzOMC/w4AVKuQBCsKicSg4ENJB77oFrCJUadTybOxPqz4hOADcwq0tcAF7VY16DjnEfHJEUiPZJT6H5EMJYkXZhuDzHN9+BNC9luedqdIBFgaquXTxWHBj/9i+VFx0rOevL0+YXvqux8jrQ+asE2fFJdwLeJtiO9b9bLFQyz3iXuyB++pgQ6mAO3rAV4T7pP5vf8SMslDDTRkevenEcIQtTBOSGvJ6bWY9aQfQlX+fsYz8PXuQUcaJxkqhFdpLe5q5zOBh8DJSGELZLZzw7DQUqf4XFicp8vLbwDp6StsD0dycWa6bN1yCFQrA52D+8PK3zvhvn2aHxWUSSQi9taHkXpp2cQqhhQMrWA4651gz+eIdHM5koI1YY6aYiVQl6ry6tsJSLKy/0xhqdiwFdPnAOFPHX0cdXxoPIfjrrgvcclJzrbRL0pgq9U5MyrsrcjleTu7vkI/gtiXeysw0ghqhW8hCNnK7poSSMUpZCcN9nQmTt3PTNJ2597LhqINNVbH6s6hJR5b9YQ/1ciT92eI6FSaXetlBicYVS84qxCE/DJqEwgYtPM641j3WuwzgwHUwR3RDzCTW8X+kR2dLXtHnhUc9SIjJEiSv1sEy17CIMefsaIbjoArtyTelbl6mG1swj5tjpeREY/+uGvxFnwRBn8WyHOaXRyzfh6fgQKg9WCfWAmcWEqFv+QecDClJ3YrSDl6UxGZA3uawVYhKUieLOhzkGeDjySOn8fV44lyRjRHUtoVf46wqWZEgEZdWsPJ2AUBtSS41D3YP+tjyZ7dbDzlUHUrU8J6yiRh42jzHKnJOeW7VJEloIos58egU7YQYBesUdIX+Thax6S512kQ0OKBy7oUUCi27aUbkZg+HDRcMmM5Hgaf+1xHddk+EBn4AgPFt2Y2A3W2RG4mwmVvT3+RtE2rozbdLhEsfm2vMo6Gv9XwIQoc7PGAeQyTNn1lO+ZpnoIzNUcrWbwd4K0FgDlf2w+5wt3mlZ3Nvw5uqP+jJzcB35/xS26XK372ZrphS5FUYCNR0Tzd8efXRzx404RV7VItr02KOkWqZE4YtDXiX1arTHOcJREtsinV+UCAZzEstlva9ILSM1jP5wCZAKWWM1G9bQwDc+7j0boPmO65R8iaWmVPADE3DVh3ctn7XDTJGqNLbs5sn6ZWGPeXpOFBDHNuLSz307HlfyjRAqjHjLUtIucIl2w59JDCpPvID+7MhKl2fSR6AVJnrzk702yBgHKy51kVLf3e87Qs2dBDFvxAEAC9vGKc87mYdS8vF0Pnt7MWe93XX/8g/p/X/BiZhqmgX4L99OdD1+HNo+n5h+3JkamMYcxBpU4BmSRMCErhtzGishm2Jox5bPuAD84eZHi49y2H+y9lCRwdVXuYKLsuVvqDTz74gCSZP/9bndEaIo4p/gu3C0zLL1lvDA523J1YabiGtuiPjZJvlCC6VoEHk0n21yutSIpsUPnYWiE81Zd/BvVGDjeeefvMJmp26iz7IYADXbFzrW707wsYNfYbizedwAVQWktpNODHJyZX9u+4dM7kHJ0OgO/7etZ+IAAogpz3Q5IVZjCJf+4ckXhn9drofWBmN4sEoPwSIUbP5Qb8ABLaBSB+hVUVWuK+J2Iv0UsYVmO2CNsb/rDWydmcfI9VtVC70s3E5DtgqP/NqjwnhkNSd9/Xt3wpv9L24q32sCU1NllMDTT7hkwWqLvBjNeH9r08qe15IcCI6LmcuvOKVputLEaqcC8qOX+skmktVOKCqFV1vx7IT4aBLlczY/uFSPh25mkoRnyEs1TqpAcKxeQvPxdRRNY0KSfHOt/0+vkfit7Ggt2AVdeDqf1o3kT60B5ulndVybsszo4dM7Deg0W/udOeMJsYRfzHAFMLzUqA4EGHXnTb8cXVDphNNvcPsiqRIQ9nUBD1uwOdFrci+3MiFU/DLaCv6CKN+NuWTiMYE2o3CBHdBDH+yDJSuthRhgaifk+dbBgrWfEcm214txiEj0mSgMI/PbMqKmMA1cgWvgO0EnjJAisGaxz6d1cvV7c/dwr45rLQBHUBJNXOx2FsCQ55OAQphICHU5Vp+/+I0/P4Ny3v828af2oenIHd/+X2YeUrt9Di4r3L/EX5CQFgj4c5hkwdFeDIiI+FnlLZ+mUGzkuuBedNNX4Go/GZJFWOBHgA1b1uvrtFuGPcKawADN68nDEDFupI//ez00UIRpeyHEVL7aPIp5HeG38KWHlWyakXA4IuF3wH4yodKBzDvXnm1sAu0JRQKm6xaeJnRrr0GhQC0anCej8k52DRBXSB383Vm2l6tobOfkNJDiWWms2JKv1WgtwJ5sw6hSYtineAoJs2tL+BIxpTHN64OOgTr4uuZ7rmsikkdyBoSwMuXRG+XmDAlrBJMnUyS+uGweEWctgWeQ1rccPXFlbHUGQ19B5xhXyJvoeT84TuBk4H8Yl/CLtfYKGni79yhmOo6eNyOTJIdlkZfiSVOcwvvaj8EyhZMUfLiCkOREzYfwEGWXOgU02vsla0sC3fIt8WMC8f3Hd3W7PYgaXHWMPBxMAhBqu2AieLk9WfTKl+FVrPvV5DMb72Mw6jlvTtZSL/mtY4OrT//Qj8D75buG0rogJFLT+lN4vmb+t5RkaOJbmpgXGgNLS8gp/B8Lybwh1uBkO1x1tolizY=";
    const CROSS_CHECK_DIGEST_HEX: &str =
        "d6104e12dc24c5dff84fdd4a7eee2f789b50a7b51820695ec7ed9c00147015fa";

    fn cross_check_state() -> (String, String) {
        use crate::space_record::cross_check_inputs::*;
        let value = |json: &str| serde_json::from_str::<Value>(json).expect("json");
        let (post, follow, linked) = (value(POST_JSON), value(FOLLOW_JSON), value(LINKED_JSON));
        let ops = vec![
            json!({"rev": "3jzfcijpj2z2a", "collection": POST, "rkey": "swordfish",
                   "cid": POST_CID, "prev": null, "value": post}),
            json!({"rev": "3jzfcijpj2z2a", "collection": FOLLOW, "rkey": "spike",
                   "cid": FOLLOW_CID, "prev": null, "value": follow}),
            json!({"rev": "3jzfcijpj2z2b", "collection": POST, "rkey": "ein",
                   "cid": LINKED_CID, "prev": null, "value": linked}),
            json!({"rev": "3jzfcijpj2z2c", "collection": POST, "rkey": "swordfish",
                   "cid": LINKED_CID, "prev": POST_CID, "value": linked}),
            json!({"rev": "3jzfcijpj2z2c", "collection": FOLLOW, "rkey": "spike",
                   "cid": null, "prev": FOLLOW_CID}),
        ];
        let body = serde_json::to_vec(&json!({ "ops": ops })).expect("serializable");
        let page =
            decode_op_page(&body, &ValueBudget::unlimited_for_tests()).expect("a well-formed page");
        let set = ChangeSet::apply(SetHashState::empty(), page.ops()).expect("applies");
        (
            STANDARD.encode(set.state().to_bytes()),
            set.state()
                .digest()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        )
    }

    #[test]
    fn the_state_and_digest_after_the_fixed_operations_are_the_pinned_constants() {
        let (state, digest) = cross_check_state();
        assert_eq!(state, CROSS_CHECK_STATE_BASE64);
        assert_eq!(digest, CROSS_CHECK_DIGEST_HEX);
    }
}

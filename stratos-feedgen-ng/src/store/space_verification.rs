//! Verified space state in the store: one checkpoint row and one path row per
//! record for each member's repo in a space, promoted together with the
//! projection rows in a single immediate transaction. The store never takes a
//! hash or a previous value from its caller: it re-reads its own rows, applies
//! the change set to them and compares the SHA-256 of the result with the
//! `data` of the MAC-verified commit. Nothing here is called by the
//! synchronizer yet.

use std::collections::HashSet;

use cid::Cid;
use serde_json::{Value, json};

use super::space::{apply_verified_space_stage_row, has_pds_member_generation};
use super::*;
use crate::{
    config::{MAX_SPACE_REPO_RECORDS, MAX_SPACE_VERIFICATION_ROWS},
    identifier::{Did, FEED_SPACE_TYPE, RecordUri, SpaceUri},
    space_mac::MacVerifiedCommit,
    space_ops::{ChangeSet, decode_op_page, projection_mutations},
    space_set_hash::{RecordPath, SetHashState, set_hash_element},
    space_sync::MAX_SPACE_PAGE_OPS,
};

/// What a promotion is for: one member's repo in one space, read from `host`
/// under membership generation `generation`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedSpaceTarget {
    pub boundary: String,
    pub space_uri: String,
    pub actor_did: String,
    pub host: String,
    pub generation: u64,
}

/// The last promoted checkpoint of a member's repo in a space.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedSpaceBase {
    pub rev: String,
    pub state: SetHashState,
    pub host: String,
    pub generation: u64,
    pub record_count: u64,
}

/// One record of a member's complete repo state in a space.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedSpaceRecord {
    pub path: RecordPath,
    pub cid: Cid,
    pub value: Value,
}

impl EncryptedStore {
    pub fn verified_space_base(
        &self,
        space_uri: &str,
        actor_did: &str,
    ) -> Result<Option<VerifiedSpaceBase>, StoreError> {
        read_checkpoint(&self.connection, space_uri, actor_did)
    }

    /// Promotes `change_set` on top of the checkpoint the caller read (`base_rev`,
    /// `None` when it read none) if and only if applying it to the stored rows
    /// gives the state `commit` covers. Any refusal changes nothing.
    pub fn promote_verified_space_repo(
        &mut self,
        target: &VerifiedSpaceTarget,
        base_rev: Option<&str>,
        commit: &MacVerifiedCommit,
        change_set: &ChangeSet,
        retained_at: &str,
        observed_at: &str,
    ) -> Result<(), StoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        write_verified_promotion(
            &transaction,
            target,
            base_rev,
            commit,
            change_set,
            retained_at,
            observed_at,
        )?;
        transaction.commit().map_err(StoreError::Open)
    }

    /// Replaces a member's whole repo state in a space from `records`, the
    /// complete set the host holds at `commit`, if and only if the hash of that
    /// set is the commit's `data`. It needs no earlier checkpoint and takes over
    /// the stored host: it is how a member is recovered after the host moved or
    /// the base is lost. Any refusal changes nothing.
    pub fn replace_verified_space_repo(
        &mut self,
        target: &VerifiedSpaceTarget,
        commit: &MacVerifiedCommit,
        records: &[VerifiedSpaceRecord],
        retained_at: &str,
        observed_at: &str,
    ) -> Result<(), StoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        write_verified_replacement(
            &transaction,
            target,
            commit,
            records,
            retained_at,
            observed_at,
        )?;
        transaction.commit().map_err(StoreError::Open)
    }
}

fn read_checkpoint(
    connection: &Connection,
    space_uri: &str,
    actor_did: &str,
) -> Result<Option<VerifiedSpaceBase>, StoreError> {
    let stored = connection
        .query_row(
            "SELECT host, generation, rev, set_hash, record_count
             FROM space_repo_state WHERE space_uri = ?1 AND did = ?2",
            params![space_uri, actor_did],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(StoreError::Open)?;
    stored
        .map(|(host, generation, rev, set_hash, record_count)| {
            Ok(VerifiedSpaceBase {
                rev,
                state: SetHashState::from_bytes(&set_hash)
                    .map_err(|_| StoreError::SpaceRepoInvalid)?,
                host,
                generation: u64::try_from(generation).map_err(|_| StoreError::SpaceRepoInvalid)?,
                record_count: u64::try_from(record_count)
                    .map_err(|_| StoreError::SpaceRepoInvalid)?,
            })
        })
        .transpose()
}

fn held_cid(
    transaction: &rusqlite::Transaction<'_>,
    target: &VerifiedSpaceTarget,
    path: &RecordPath,
) -> Result<Option<String>, StoreError> {
    transaction
        .query_row(
            "SELECT cid FROM space_repo_record
             WHERE space_uri = ?1 AND did = ?2 AND collection = ?3 AND rkey = ?4",
            params![
                target.space_uri,
                target.actor_did,
                path.collection(),
                path.rkey()
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::Open)
}

fn other_members_rows(
    transaction: &rusqlite::Transaction<'_>,
    target: &VerifiedSpaceTarget,
) -> Result<i64, StoreError> {
    transaction
        .query_row(
            "SELECT COALESCE(SUM(record_count), 0) FROM space_repo_state
             WHERE NOT (space_uri = ?1 AND did = ?2)",
            params![target.space_uri, target.actor_did],
            |row| row.get(0),
        )
        .map_err(StoreError::Open)
}

/// What a target must satisfy before anything else is read: well-formed
/// identifiers and times, a boundary that names the target's space, and the
/// membership generation the caller holds.
fn check_target(
    transaction: &rusqlite::Transaction<'_>,
    target: &VerifiedSpaceTarget,
    retained_at: &str,
    observed_at: &str,
) -> Result<(SpaceUri, Did, i64), StoreError> {
    let space = SpaceUri::parse(&target.space_uri).map_err(|_| StoreError::SpaceRepoInvalid)?;
    let author = Did::parse(target.actor_did.clone()).map_err(|_| StoreError::SpaceRepoInvalid)?;
    // Posts are written under the target's boundary, so a space the boundary
    // does not name would serve its records to that boundary's viewers.
    let space_of_boundary = target
        .boundary
        .split_once('/')
        .and_then(|(authority, key)| SpaceUri::new(authority, FEED_SPACE_TYPE, key).ok());
    if space_of_boundary.as_ref() != Some(&space)
        || target.boundary.is_empty()
        || target.host.is_empty()
        || !is_utc_timestamp(retained_at)
        || !is_utc_timestamp(observed_at)
    {
        return Err(StoreError::SpaceRepoInvalid);
    }
    let generation = i64::try_from(target.generation).map_err(|_| StoreError::SpaceRepoInvalid)?;
    if !has_pds_member_generation(
        transaction,
        &target.boundary,
        &target.actor_did,
        target.generation,
    )? {
        return Err(StoreError::UnauthorizedSpaceMember);
    }
    Ok((space, author, generation))
}

fn write_checkpoint(
    transaction: &rusqlite::Transaction<'_>,
    target: &VerifiedSpaceTarget,
    generation: i64,
    rev: &str,
    state: &SetHashState,
    record_count: i64,
    observed_at: &str,
) -> Result<(), StoreError> {
    transaction
        .execute(
            "INSERT INTO space_repo_state
               (space_uri, did, boundary, host, generation, rev, set_hash, record_count, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(space_uri, did) DO UPDATE SET boundary = excluded.boundary,
               host = excluded.host, generation = excluded.generation, rev = excluded.rev,
               set_hash = excluded.set_hash, record_count = excluded.record_count,
               updated_at = excluded.updated_at",
            params![
                target.space_uri,
                target.actor_did,
                target.boundary,
                target.host,
                generation,
                rev,
                state.to_bytes().as_slice(),
                record_count,
                observed_at,
            ],
        )
        .map_err(StoreError::Open)?;
    Ok(())
}

fn apply_projection(
    transaction: &rusqlite::Transaction<'_>,
    target: &VerifiedSpaceTarget,
    mutations: Vec<SpaceStageMutation>,
    retained_at: &str,
    observed_at: &str,
) -> Result<(), StoreError> {
    for mutation in mutations {
        apply_verified_space_stage_row(
            transaction,
            &target.space_uri,
            &target.actor_did,
            retained_at,
            stage_row_of(mutation, &target.boundary, observed_at),
        )?;
    }
    Ok(())
}

/// Everything a promotion decides and writes. The caller owns the transaction,
/// so dropping it without committing leaves no trace.
fn write_verified_promotion(
    transaction: &rusqlite::Transaction<'_>,
    target: &VerifiedSpaceTarget,
    base_rev: Option<&str>,
    commit: &MacVerifiedCommit,
    change_set: &ChangeSet,
    retained_at: &str,
    observed_at: &str,
) -> Result<(), StoreError> {
    let (space, author, generation) = check_target(transaction, target, retained_at, observed_at)?;
    let checkpoint = read_checkpoint(transaction, &target.space_uri, &target.actor_did)?;
    if checkpoint
        .as_ref()
        .is_some_and(|stored| stored.host != target.host || stored.generation != target.generation)
    {
        return Err(StoreError::SpaceRepoFenced);
    }
    if checkpoint.as_ref().map(|stored| stored.rev.as_str()) != base_rev {
        return Err(StoreError::SpaceRepoBaseMoved);
    }
    if commit.repo() != target.actor_did || commit.space() != target.space_uri {
        return Err(StoreError::SpaceRepoInvalid);
    }
    if base_rev.is_some_and(|base| commit.rev() < base) {
        return Err(StoreError::SpaceRepoInvalid);
    }

    let changes = change_set.changes();
    if changes.len() > MAX_SPACE_PAGE_OPS {
        return Err(StoreError::SpaceRepoOverBudget);
    }
    let held_before = checkpoint
        .as_ref()
        .map_or(0, |stored| stored.record_count as i64);
    let mut state = checkpoint.map_or_else(SetHashState::empty, |stored| stored.state);
    let mut record_count = held_before;
    for change in changes {
        let held = held_cid(transaction, target, change.path())?;
        if held != change.expected_prev().map(ToString::to_string) {
            return Err(StoreError::SpaceRepoPreviousMismatch);
        }
        if let Some(previous) = change.expected_prev() {
            state.remove(&set_hash_element(change.path(), previous));
        }
        if let Some(current) = change.cid() {
            state.add(&set_hash_element(change.path(), current));
        }
        record_count += i64::from(change.cid().is_some()) - i64::from(held.is_some());
    }
    if record_count > MAX_SPACE_REPO_RECORDS as i64
        || other_members_rows(transaction, target)? + record_count
            > MAX_SPACE_VERIFICATION_ROWS as i64
    {
        return Err(StoreError::SpaceRepoOverBudget);
    }
    if &state.digest() != commit.data() {
        return Err(StoreError::SpaceRepoDigestMismatch);
    }

    for change in changes {
        match change.cid() {
            Some(cid) => transaction.execute(
                "INSERT INTO space_repo_record (space_uri, did, collection, rkey, boundary, cid)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(space_uri, did, collection, rkey)
                 DO UPDATE SET boundary = excluded.boundary, cid = excluded.cid",
                params![
                    target.space_uri,
                    target.actor_did,
                    change.path().collection(),
                    change.path().rkey(),
                    target.boundary,
                    cid.to_string(),
                ],
            ),
            None => transaction.execute(
                "DELETE FROM space_repo_record
                 WHERE space_uri = ?1 AND did = ?2 AND collection = ?3 AND rkey = ?4",
                params![
                    target.space_uri,
                    target.actor_did,
                    change.path().collection(),
                    change.path().rkey(),
                ],
            ),
        }
        .map_err(StoreError::Open)?;
    }
    write_checkpoint(
        transaction,
        target,
        generation,
        commit.rev(),
        &state,
        record_count,
        observed_at,
    )?;

    let mutations = projection_mutations(&space, &author, changes, observed_at)
        .map_err(|_| StoreError::SpaceRepoInvalid)?;
    apply_projection(transaction, target, mutations, retained_at, observed_at)
}

/// Everything a replacement decides and writes; the caller owns the transaction.
fn write_verified_replacement(
    transaction: &rusqlite::Transaction<'_>,
    target: &VerifiedSpaceTarget,
    commit: &MacVerifiedCommit,
    records: &[VerifiedSpaceRecord],
    retained_at: &str,
    observed_at: &str,
) -> Result<(), StoreError> {
    let (space, author, generation) = check_target(transaction, target, retained_at, observed_at)?;
    if commit.repo() != target.actor_did || commit.space() != target.space_uri {
        return Err(StoreError::SpaceRepoInvalid);
    }
    if records.len() > MAX_SPACE_REPO_RECORDS
        || other_members_rows(transaction, target)? + records.len() as i64
            > MAX_SPACE_VERIFICATION_ROWS as i64
    {
        return Err(StoreError::SpaceRepoOverBudget);
    }
    if !records.windows(2).all(|pair| {
        (pair[0].path.collection(), pair[0].path.rkey())
            < (pair[1].path.collection(), pair[1].path.rkey())
    }) {
        return Err(StoreError::SpaceRepoInvalid);
    }
    let (state, mutations) = rebuild_state(&space, &author, commit.rev(), records, observed_at)?;
    if &state.digest() != commit.data() {
        return Err(StoreError::SpaceRepoDigestMismatch);
    }

    remove_projection_not_in(
        transaction,
        target,
        &space,
        &author,
        &mutations,
        retained_at,
        observed_at,
    )?;
    transaction
        .execute(
            "DELETE FROM space_repo_record WHERE space_uri = ?1 AND did = ?2",
            params![target.space_uri, target.actor_did],
        )
        .map_err(StoreError::Open)?;
    let mut insert = transaction
        .prepare(
            "INSERT INTO space_repo_record (space_uri, did, collection, rkey, boundary, cid)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(StoreError::Open)?;
    for record in records {
        insert
            .execute(params![
                target.space_uri,
                target.actor_did,
                record.path.collection(),
                record.path.rkey(),
                target.boundary,
                record.cid.to_string(),
            ])
            .map_err(StoreError::Open)?;
    }
    drop(insert);
    write_checkpoint(
        transaction,
        target,
        generation,
        commit.rev(),
        &state,
        records.len() as i64,
        observed_at,
    )?;
    apply_projection(transaction, target, mutations, retained_at, observed_at)
}

/// Hashes the set from scratch and derives its projection. The records go
/// through the same decoder and change set as a page of operations, in chunks
/// the size of a page, so a value is held to its CID by the one code that
/// already does it; a value the encoder refuses refuses the whole set.
fn rebuild_state(
    space: &SpaceUri,
    author: &Did,
    rev: &str,
    records: &[VerifiedSpaceRecord],
    observed_at: &str,
) -> Result<(SetHashState, Vec<SpaceStageMutation>), StoreError> {
    let mut state = SetHashState::empty();
    let mut mutations = Vec::new();
    for chunk in records.chunks(MAX_SPACE_PAGE_OPS) {
        let ops: Vec<Value> = chunk
            .iter()
            .map(|record| {
                json!({
                    "rev": rev,
                    "collection": record.path.collection(),
                    "rkey": record.path.rkey(),
                    "cid": record.cid.to_string(),
                    "prev": null,
                    "value": record.value,
                })
            })
            .collect();
        let body =
            serde_json::to_vec(&json!({ "ops": ops })).map_err(|_| StoreError::SpaceRepoInvalid)?;
        let page = decode_op_page(&body).map_err(|_| StoreError::SpaceRepoInvalid)?;
        let change_set =
            ChangeSet::apply(state, page.ops()).map_err(|_| StoreError::SpaceRepoInvalid)?;
        mutations.extend(
            projection_mutations(space, author, change_set.changes(), observed_at)
                .map_err(|_| StoreError::SpaceRepoInvalid)?,
        );
        state = change_set.state().clone();
    }
    Ok((state, mutations))
}

/// Removes every post and interaction this member has in this space that the
/// replacement does not write again. Rows are matched by parsing their URI, so
/// custody rows and other spaces are never candidates; removal goes through the
/// same row application as every other projection change.
fn remove_projection_not_in(
    transaction: &rusqlite::Transaction<'_>,
    target: &VerifiedSpaceTarget,
    space: &SpaceUri,
    author: &Did,
    mutations: &[SpaceStageMutation],
    retained_at: &str,
    observed_at: &str,
) -> Result<(), StoreError> {
    let rewritten: HashSet<&str> = mutations
        .iter()
        .filter_map(|mutation| match mutation {
            SpaceStageMutation::Upsert { uri, .. } => Some(uri.as_str()),
            SpaceStageMutation::Delete { .. } => None,
        })
        .collect();
    let mut statement = transaction
        .prepare(
            "SELECT uri FROM post WHERE author_did = ?1
             UNION SELECT uri FROM interaction WHERE actor_did = ?1",
        )
        .map_err(StoreError::Open)?;
    let uris = statement
        .query_map([&target.actor_did], |row| row.get::<_, String>(0))
        .map_err(StoreError::Open)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::Open)?;
    drop(statement);
    let removals = uris
        .into_iter()
        .filter(|uri| is_record_of(uri, space, author) && !rewritten.contains(uri.as_str()))
        .map(|uri| SpaceStageMutation::Delete { uri })
        .collect();
    apply_projection(transaction, target, removals, retained_at, observed_at)
}

fn is_record_of(uri: &str, space: &SpaceUri, author: &Did) -> bool {
    match RecordUri::parse(uri) {
        Ok(RecordUri::Space {
            authority,
            space_type,
            space_key,
            author: record_author,
            ..
        }) => {
            record_author == *author
                && SpaceUri::new(authority.as_str(), &space_type, &space_key)
                    .is_ok_and(|record_space| record_space == *space)
        }
        _ => false,
    }
}

/// The boundary of a projected row is the target's, never anything the record says.
fn stage_row_of(mutation: SpaceStageMutation, boundary: &str, updated_at: &str) -> SpaceStageRow {
    match mutation {
        SpaceStageMutation::Upsert {
            uri,
            cid,
            sort_at,
            indexed_at,
            record_json,
            blob_refs_json,
        } => SpaceStageRow {
            uri,
            boundary: boundary.to_owned(),
            deleted: false,
            cid: Some(cid),
            sort_at: Some(sort_at),
            indexed_at: Some(indexed_at),
            record_json: Some(record_json),
            blob_refs_json: Some(blob_refs_json),
            updated_at: updated_at.to_owned(),
        },
        SpaceStageMutation::Delete { uri } => SpaceStageRow {
            uri,
            boundary: boundary.to_owned(),
            deleted: true,
            cid: None,
            sort_at: None,
            indexed_at: None,
            record_json: None,
            blob_refs_json: None,
            updated_at: updated_at.to_owned(),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, path::PathBuf};

    use base64::{
        Engine,
        engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    };
    use cid::Cid;
    use serde_json::{Value, json};

    use super::*;
    use crate::{
        moderation_label::{LabelPage, LabelSubject, ModerationLabel},
        space_ops::decode_op_page,
        space_record::{encode_record, record_cid},
        space_set_hash::RecordPath,
        store::{ActorEnrollment, PdsSpaceMember},
    };

    const OP_PAGES: &str =
        include_str!("../../../test/spaces-alignment/november/fixtures/op-pages.json");
    const SPACE: &str = "at:space/did:web:bebop.example/zone.stratos.space.feed/crew";
    const BOUNDARY: &str = "did:web:bebop.example/crew";
    const AUTHORITY: &str = "did:web:bebop.example";
    const FAYE: &str = "did:plc:fayevalentine";
    const JET: &str = "did:plc:jetblack";
    const HOST: &str = "https://pds.bebop.example";
    const OBSERVED: &str = "2026-09-22T00:00:00.000Z";
    const RETAINED: &str = "2026-09-23T00:00:00.000Z";
    const AS_OF: &str = "2026-09-22T12:00:00.000Z";
    const POST: &str = "zone.stratos.feed.post";
    const FOLLOW: &str = "app.bsky.graph.follow";

    type Model = BTreeMap<(String, String), Cid>;

    fn key() -> StorageKey {
        StorageKey::from_bytes([7; 32])
    }

    fn members(store: &mut EncryptedStore, dids: &[&str]) {
        store
            .replace_pds_space_members(
                BOUNDARY,
                dids.iter()
                    .map(|did| PdsSpaceMember {
                        did: (*did).to_owned(),
                    })
                    .collect(),
                OBSERVED,
            )
            .unwrap();
    }

    fn memory_store() -> EncryptedStore {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        members(&mut store, &[FAYE]);
        store
    }

    fn file_path(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "stratos-feedgen-ng-verified-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        path
    }

    fn target_of(store: &EncryptedStore, did: &str) -> VerifiedSpaceTarget {
        VerifiedSpaceTarget {
            boundary: BOUNDARY.to_owned(),
            space_uri: SPACE.to_owned(),
            actor_did: did.to_owned(),
            host: HOST.to_owned(),
            generation: store.pds_member_generation(BOUNDARY, did).unwrap().unwrap(),
        }
    }

    fn fixture_pages() -> Vec<Value> {
        serde_json::from_str::<Value>(OP_PAGES).unwrap()["pages"]
            .as_array()
            .unwrap()
            .clone()
    }

    fn commit_of_page(page: &Value) -> MacVerifiedCommit {
        let commit = &page["commit"];
        MacVerifiedCommit::for_tests(
            commit["repo"].as_str().unwrap(),
            commit["space"].as_str().unwrap(),
            commit["rev"].as_str().unwrap(),
            STANDARD_NO_PAD
                .decode(commit["data"]["$bytes"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap(),
        )
    }

    fn change_set_over(store: &EncryptedStore, did: &str, ops: &Value) -> ChangeSet {
        let base = store.verified_space_base(SPACE, did).unwrap();
        let state = base.map_or_else(SetHashState::empty, |base| base.state);
        let body = serde_json::to_vec(&json!({ "ops": ops })).unwrap();
        ChangeSet::apply(state, decode_op_page(&body).unwrap().ops()).unwrap()
    }

    fn promote_with(
        store: &mut EncryptedStore,
        target: &VerifiedSpaceTarget,
        commit: &MacVerifiedCommit,
        ops: &Value,
    ) -> Result<(), StoreError> {
        let base = store
            .verified_space_base(SPACE, &target.actor_did)
            .unwrap()
            .map(|base| base.rev);
        let change_set = change_set_over(store, &target.actor_did, ops);
        store.promote_verified_space_repo(
            target,
            base.as_deref(),
            commit,
            &change_set,
            RETAINED,
            OBSERVED,
        )
    }

    fn promote_page(store: &mut EncryptedStore, page: &Value) -> Result<(), StoreError> {
        let target = target_of(store, FAYE);
        promote_with(store, &target, &commit_of_page(page), &page["ops"])
    }

    fn model_after(model: &mut Model, ops: &Value) {
        for op in ops.as_array().unwrap() {
            let path = (
                op["collection"].as_str().unwrap().to_owned(),
                op["rkey"].as_str().unwrap().to_owned(),
            );
            match op["cid"].as_str() {
                Some(cid) => model.insert(path, Cid::try_from(cid).unwrap()),
                None => model.remove(&path),
            };
        }
    }

    fn hashed(model: &Model) -> SetHashState {
        let mut state = SetHashState::empty();
        for ((collection, rkey), cid) in model {
            let path = RecordPath::parse(collection, rkey).unwrap();
            state.add(&set_hash_element(&path, cid));
        }
        state
    }

    fn model_commit(did: &str, rev: &str, model: &Model) -> MacVerifiedCommit {
        MacVerifiedCommit::for_tests(did, SPACE, rev, hashed(model).digest())
    }

    fn stored_paths(store: &EncryptedStore, did: &str) -> Model {
        store
            .connection
            .prepare(
                "SELECT collection, rkey, cid FROM space_repo_record WHERE space_uri = ?1 AND did = ?2",
            )
            .unwrap()
            .query_map(params![SPACE, did], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })
            .unwrap()
            .map(|row| {
                let (collection, rkey, cid) = row.unwrap();
                ((collection, rkey), Cid::try_from(cid.as_str()).unwrap())
            })
            .collect()
    }

    fn count(store: &EncryptedStore, table: &str) -> i64 {
        store
            .connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn served_posts(store: &EncryptedStore) -> Vec<(String, String)> {
        let mut posts: Vec<_> = store
            .list_posts_by_boundary(BOUNDARY, None, 50, AS_OF)
            .unwrap()
            .posts
            .into_iter()
            .map(|post| (post.uri, post.cid))
            .collect();
        posts.sort();
        posts
    }

    fn record_uri(did: &str, collection: &str, rkey: &str) -> String {
        format!("{SPACE}/{did}/{collection}/{rkey}")
    }

    fn cid_of(value: &Value) -> Cid {
        record_cid(&encode_record(value).unwrap())
    }

    fn op(
        rev: &str,
        collection: &str,
        rkey: &str,
        cid: Option<&Cid>,
        prev: Option<&Cid>,
        value: Option<&Value>,
    ) -> Value {
        let mut op = json!({
            "rev": rev,
            "collection": collection,
            "rkey": rkey,
            "cid": cid.map(ToString::to_string),
            "prev": prev.map(ToString::to_string),
        });
        if let Some(value) = value {
            op["value"] = value.clone();
        }
        op
    }

    fn post_value(text: &str) -> Value {
        json!({ "$type": POST, "text": text })
    }

    fn create_post(rev: &str, rkey: &str, value: &Value) -> Value {
        op(rev, POST, rkey, Some(&cid_of(value)), None, Some(value))
    }

    fn snapshot(
        store: &EncryptedStore,
    ) -> (Option<VerifiedSpaceBase>, Model, Vec<(String, String)>, i64) {
        (
            store.verified_space_base(SPACE, FAYE).unwrap(),
            stored_paths(store, FAYE),
            served_posts(store),
            count(store, "interaction"),
        )
    }

    // Real store, ops from op-pages.json: the oracle's commit after each page.

    #[test]
    fn the_three_fixture_pages_promote_in_turn_and_serve_what_is_admitted() {
        let mut store = memory_store();
        let pages = fixture_pages();
        let mut model = Model::new();
        for (index, page) in pages.iter().enumerate() {
            promote_page(&mut store, page).unwrap();
            model_after(&mut model, &page["ops"]);

            let base = store.verified_space_base(SPACE, FAYE).unwrap().unwrap();
            assert_eq!(
                base.rev,
                page["commit"]["rev"].as_str().unwrap(),
                "page {index}"
            );
            assert_eq!(base.state, hashed(&model), "page {index}");
            assert_eq!(
                base.state.digest(),
                *commit_of_page(page).data(),
                "page {index}"
            );
            assert_eq!(base.record_count, model.len() as u64);
            assert_eq!(base.host, HOST);
            assert_eq!(stored_paths(&store, FAYE), model, "page {index}");
        }
        let fixture: Value = serde_json::from_str(OP_PAGES).unwrap();
        let final_state = STANDARD
            .decode(fixture["stateAfterLastPage"]["value"].as_str().unwrap())
            .unwrap();
        let stored = store.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(stored.state.to_bytes().as_slice(), final_state.as_slice());
        assert_eq!(model.len(), 4, "swordfish, ein, the repost and the follow");

        let served: Vec<String> = served_posts(&store)
            .into_iter()
            .map(|(uri, _)| uri)
            .collect();
        assert_eq!(
            served,
            vec![
                record_uri(FAYE, POST, "ein"),
                record_uri(FAYE, POST, "swordfish")
            ]
        );
        let interactions = store.interaction_rows();
        assert_eq!(interactions.len(), 1);
        assert_eq!(
            interactions[0].0,
            record_uri(FAYE, "app.bsky.feed.repost", "jet")
        );
        assert_eq!(interactions[0].3, BOUNDARY);
        assert!(model.contains_key(&(FOLLOW.to_owned(), "faye".to_owned())));
        assert!(!served.iter().any(|uri| uri.contains("follow")));
    }

    #[test]
    fn the_first_page_serves_a_post_a_like_and_a_repost_and_only_path_rows_for_the_follow() {
        let mut store = memory_store();
        promote_page(&mut store, &fixture_pages()[0]).unwrap();

        let posts = served_posts(&store);
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].0, record_uri(FAYE, POST, "swordfish"));
        assert_eq!(
            posts[0].1,
            "bafyreia2riwiofeyueakvuobrujsfp6rovaqbfkbi5v455itkaoyxf4wii"
        );
        let kinds: Vec<String> = store
            .interaction_rows()
            .into_iter()
            .map(|row| row.1)
            .collect();
        assert_eq!(kinds, vec!["like", "repost"]);
        assert_eq!(count(&store, "space_repo_record"), 4);
        assert_eq!(count(&store, "post"), 1);
    }

    #[test]
    fn a_wrong_digest_changes_nothing_and_the_earlier_checkpoint_stands() {
        let mut store = memory_store();
        let pages = fixture_pages();
        promote_page(&mut store, &pages[0]).unwrap();
        let before = snapshot(&store);

        let target = target_of(&store, FAYE);
        let wrong = MacVerifiedCommit::for_tests(
            FAYE,
            SPACE,
            "3jzfcijpj2z2d",
            *commit_of_page(&pages[0]).data(),
        );
        let outcome = promote_with(&mut store, &target, &wrong, &pages[1]["ops"]);

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoDigestMismatch)),
            "{outcome:?}"
        );
        assert_eq!(snapshot(&store), before);
        assert_eq!(before.0.as_ref().unwrap().rev, "3jzfcijpj2z2b");
    }

    #[test]
    fn leaving_out_the_operation_of_a_record_that_is_not_projected_is_a_digest_mismatch() {
        let mut store = memory_store();
        let page = &fixture_pages()[0];
        let mut ops = page["ops"].clone();
        ops.as_array_mut()
            .unwrap()
            .retain(|op| op["collection"] != FOLLOW);
        let target = target_of(&store, FAYE);

        let outcome = promote_with(&mut store, &target, &commit_of_page(page), &ops);

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoDigestMismatch)),
            "{outcome:?}"
        );
        assert_eq!(count(&store, "space_repo_record"), 0);
        assert_eq!(count(&store, "space_repo_state"), 0);
        assert_eq!(count(&store, "post"), 0);
    }

    #[test]
    fn the_store_recomputes_the_state_instead_of_taking_the_callers() {
        let mut store = memory_store();
        let pages = fixture_pages();
        promote_page(&mut store, &pages[0]).unwrap();
        let before = snapshot(&store);

        // A caller that forgot the stored state builds a set that is consistent
        // with its own commit, but not with the rows the store holds.
        let body = serde_json::to_vec(&json!({ "ops": pages[1]["ops"] })).unwrap();
        let from_nothing =
            ChangeSet::apply(SetHashState::empty(), decode_op_page(&body).unwrap().ops()).unwrap();
        let self_consistent = MacVerifiedCommit::for_tests(
            FAYE,
            SPACE,
            "3jzfcijpj2z2d",
            from_nothing.state().digest(),
        );
        assert!(from_nothing.clone().prove(&self_consistent).is_ok());
        let target = target_of(&store, FAYE);

        let outcome = store.promote_verified_space_repo(
            &target,
            Some("3jzfcijpj2z2b"),
            &self_consistent,
            &from_nothing,
            RETAINED,
            OBSERVED,
        );

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoDigestMismatch)),
            "{outcome:?}"
        );
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn a_change_whose_expected_previous_cid_is_not_the_stored_one_is_refused() {
        let mut store = memory_store();
        let pages = fixture_pages();
        promote_page(&mut store, &pages[0]).unwrap();
        let before = snapshot(&store);

        let stale_prev = cid_of(&post_value("See you space cowboy"));
        let replacement = post_value("Bang");
        let ops = json!([op(
            "3jzfcijpj2z2c",
            POST,
            "swordfish",
            Some(&cid_of(&replacement)),
            Some(&stale_prev),
            Some(&replacement)
        )]);
        let mut model = stored_paths(&store, FAYE);
        model.insert(
            (POST.to_owned(), "swordfish".to_owned()),
            cid_of(&replacement),
        );
        let target = target_of(&store, FAYE);

        let outcome = promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2c", &model),
            &ops,
        );

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoPreviousMismatch)),
            "{outcome:?}"
        );
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn a_create_over_a_record_the_store_already_holds_is_a_previous_mismatch() {
        let mut store = memory_store();
        promote_page(&mut store, &fixture_pages()[0]).unwrap();
        let before = snapshot(&store);
        let value = post_value("Bang");
        let ops = json!([create_post("3jzfcijpj2z2c", "swordfish", &value)]);
        let mut model = stored_paths(&store, FAYE);
        model.insert((POST.to_owned(), "swordfish".to_owned()), cid_of(&value));
        let target = target_of(&store, FAYE);

        let outcome = promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2c", &model),
            &ops,
        );

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoPreviousMismatch)),
            "{outcome:?}"
        );
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn a_second_promotion_from_the_same_base_is_refused() {
        let mut store = memory_store();
        let pages = fixture_pages();
        let target = target_of(&store, FAYE);
        let change_set = change_set_over(&store, FAYE, &pages[0]["ops"]);
        let commit = commit_of_page(&pages[0]);
        store
            .promote_verified_space_repo(&target, None, &commit, &change_set, RETAINED, OBSERVED)
            .unwrap();
        let before = snapshot(&store);

        let again = store.promote_verified_space_repo(
            &target,
            None,
            &commit,
            &change_set,
            RETAINED,
            OBSERVED,
        );
        assert!(
            matches!(again, Err(StoreError::SpaceRepoBaseMoved)),
            "{again:?}"
        );

        let second_page = change_set_over(&store, FAYE, &pages[1]["ops"]);
        let stale_base = store.promote_verified_space_repo(
            &target,
            Some("3jzfcijpj2z2a"),
            &commit_of_page(&pages[1]),
            &second_page,
            RETAINED,
            OBSERVED,
        );
        assert!(
            matches!(stale_base, Err(StoreError::SpaceRepoBaseMoved)),
            "{stale_base:?}"
        );
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn a_base_the_caller_invented_for_a_member_with_no_checkpoint_is_refused() {
        let mut store = memory_store();
        let page = &fixture_pages()[0];
        let target = target_of(&store, FAYE);
        let change_set = change_set_over(&store, FAYE, &page["ops"]);

        let outcome = store.promote_verified_space_repo(
            &target,
            Some("3jzfcijpj2z2a"),
            &commit_of_page(page),
            &change_set,
            RETAINED,
            OBSERVED,
        );

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoBaseMoved)),
            "{outcome:?}"
        );
        assert_eq!(count(&store, "space_repo_state"), 0);
    }

    #[test]
    fn a_generation_bumped_between_the_read_and_the_promotion_is_unauthorized() {
        let mut store = memory_store();
        let page = &fixture_pages()[0];
        let target = target_of(&store, FAYE);
        let change_set = change_set_over(&store, FAYE, &page["ops"]);
        store.reset_pds_member_space_state(BOUNDARY, FAYE).unwrap();

        let outcome = store.promote_verified_space_repo(
            &target,
            None,
            &commit_of_page(page),
            &change_set,
            RETAINED,
            OBSERVED,
        );

        assert!(
            matches!(outcome, Err(StoreError::UnauthorizedSpaceMember)),
            "{outcome:?}"
        );
        assert_eq!(count(&store, "space_repo_record"), 0);
        assert_eq!(count(&store, "post"), 0);
    }

    #[test]
    fn a_member_who_left_cannot_be_promoted() {
        let mut store = memory_store();
        let page = &fixture_pages()[0];
        let target = target_of(&store, FAYE);
        let change_set = change_set_over(&store, FAYE, &page["ops"]);
        members(&mut store, &[]);

        let outcome = store.promote_verified_space_repo(
            &target,
            None,
            &commit_of_page(page),
            &change_set,
            RETAINED,
            OBSERVED,
        );

        assert!(
            matches!(outcome, Err(StoreError::UnauthorizedSpaceMember)),
            "{outcome:?}"
        );
    }

    #[test]
    fn a_host_other_than_the_stored_one_is_fenced() {
        let mut store = memory_store();
        let pages = fixture_pages();
        promote_page(&mut store, &pages[0]).unwrap();
        let before = snapshot(&store);
        let mut elsewhere = target_of(&store, FAYE);
        elsewhere.host = "https://pds.red-tail.example".to_owned();

        let outcome = promote_with(
            &mut store,
            &elsewhere,
            &commit_of_page(&pages[1]),
            &pages[1]["ops"],
        );

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoFenced)),
            "{outcome:?}"
        );
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn a_commit_for_another_repo_or_space_is_invalid() {
        let mut store = memory_store();
        let page = &fixture_pages()[0];
        let target = target_of(&store, FAYE);
        let genuine = commit_of_page(page);
        for commit in [
            MacVerifiedCommit::for_tests(JET, SPACE, genuine.rev(), *genuine.data()),
            MacVerifiedCommit::for_tests(
                FAYE,
                "at:space/did:web:bebop.example/zone.stratos.space.feed/other",
                genuine.rev(),
                *genuine.data(),
            ),
        ] {
            let outcome = promote_with(&mut store, &target, &commit, &page["ops"]);
            assert!(
                matches!(outcome, Err(StoreError::SpaceRepoInvalid)),
                "{outcome:?}"
            );
        }
        assert_eq!(count(&store, "space_repo_state"), 0);
        assert_eq!(count(&store, "space_repo_record"), 0);
    }

    #[test]
    fn a_commit_older_than_the_base_is_invalid() {
        let mut store = memory_store();
        let pages = fixture_pages();
        promote_page(&mut store, &pages[0]).unwrap();
        let before = snapshot(&store);
        let target = target_of(&store, FAYE);
        let older = MacVerifiedCommit::for_tests(
            FAYE,
            SPACE,
            "3jzfcijpj2z29",
            *commit_of_page(&pages[1]).data(),
        );

        let outcome = promote_with(&mut store, &target, &older, &pages[1]["ops"]);

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoInvalid)),
            "{outcome:?}"
        );
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn an_inadmissible_replacement_of_a_served_post_removes_it() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);
        let admitted = post_value("See you space cowboy");
        let mut model = Model::new();
        let first = json!([create_post("3jzfcijpj2z2a", "swordfish", &admitted)]);
        model_after(&mut model, &first);
        promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2a", &model),
            &first,
        )
        .unwrap();
        assert_eq!(served_posts(&store).len(), 1);

        let impostor = json!({ "$type": "app.bsky.feed.post", "text": "See you space cowboy" });
        let second = json!([op(
            "3jzfcijpj2z2b",
            POST,
            "swordfish",
            Some(&cid_of(&impostor)),
            Some(&cid_of(&admitted)),
            Some(&impostor)
        )]);
        model_after(&mut model, &second);
        promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2b", &model),
            &second,
        )
        .unwrap();

        assert!(served_posts(&store).is_empty());
        assert_eq!(stored_paths(&store, FAYE), model);
        assert_eq!(
            model[&(POST.to_owned(), "swordfish".to_owned())],
            cid_of(&impostor)
        );
    }

    #[test]
    fn a_replacement_that_arrives_without_its_record_removes_the_served_post() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);
        let admitted = post_value("See you space cowboy");
        let mut model = Model::new();
        let first = json!([create_post("3jzfcijpj2z2a", "swordfish", &admitted)]);
        model_after(&mut model, &first);
        promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2a", &model),
            &first,
        )
        .unwrap();

        let edited = post_value("See you space cowboy, edited");
        let second = json!([op(
            "3jzfcijpj2z2b",
            POST,
            "swordfish",
            Some(&cid_of(&edited)),
            Some(&cid_of(&admitted)),
            None
        )]);
        model_after(&mut model, &second);
        promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2b", &model),
            &second,
        )
        .unwrap();

        assert!(served_posts(&store).is_empty());
        assert_eq!(stored_paths(&store, FAYE), model);
    }

    #[test]
    fn a_delete_removes_the_post_and_the_interactions_that_pointed_at_it() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);
        let admitted = post_value("See you space cowboy");
        let post_uri = record_uri(FAYE, POST, "swordfish");
        let like = json!({
            "$type": "app.bsky.feed.like",
            "subject": { "uri": post_uri, "cid": cid_of(&admitted).to_string() }
        });
        let first = json!([
            create_post("3jzfcijpj2z2a", "swordfish", &admitted),
            op(
                "3jzfcijpj2z2a",
                "app.bsky.feed.like",
                "ed",
                Some(&cid_of(&like)),
                None,
                Some(&like)
            ),
        ]);
        let mut model = Model::new();
        model_after(&mut model, &first);
        promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2a", &model),
            &first,
        )
        .unwrap();
        assert_eq!(store.interaction_rows().len(), 1);
        assert_eq!(served_posts(&store).len(), 1);

        let second = json!([op(
            "3jzfcijpj2z2b",
            POST,
            "swordfish",
            None,
            Some(&cid_of(&admitted)),
            None
        )]);
        model_after(&mut model, &second);
        promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2b", &model),
            &second,
        )
        .unwrap();

        assert!(served_posts(&store).is_empty());
        assert!(
            store.interaction_rows().is_empty(),
            "the like of the deleted post goes with it"
        );
        assert_eq!(
            stored_paths(&store, FAYE).len(),
            1,
            "only the like keeps a path row"
        );
    }

    #[test]
    fn the_boundary_is_the_targets_whatever_the_record_claims() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);
        let forged = json!({
            "$type": POST,
            "text": "See you space cowboy",
            "boundary": { "values": ["did:web:bebop.example/forged"] }
        });
        let ops = json!([create_post("3jzfcijpj2z2a", "swordfish", &forged)]);
        let mut model = Model::new();
        model_after(&mut model, &ops);

        promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2a", &model),
            &ops,
        )
        .unwrap();

        assert_eq!(served_posts(&store).len(), 1);
        let boundaries: Vec<String> = store
            .connection
            .prepare("SELECT boundary FROM post_boundary")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(boundaries, vec![BOUNDARY.to_owned()]);
        let recorded: String = store
            .connection
            .query_row("SELECT boundary FROM space_repo_record", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(recorded, BOUNDARY);
    }

    fn take_down(store: &mut EncryptedStore, subject: LabelSubject) {
        store
            .apply_label_page(
                AUTHORITY,
                &LabelPage {
                    cursor: 1,
                    labels: vec![ModerationLabel {
                        seq: 1,
                        subject,
                        neg: false,
                    }],
                    skipped_subjects: 0,
                },
                OBSERVED,
            )
            .unwrap();
    }

    #[test]
    fn a_record_under_a_takedown_is_not_projected_and_keeps_its_path_row() {
        let mut store = memory_store();
        take_down(
            &mut store,
            LabelSubject::Record {
                uri: record_uri(FAYE, POST, "swordfish"),
                author_did: FAYE.to_owned(),
            },
        );

        promote_page(&mut store, &fixture_pages()[0]).unwrap();

        assert!(served_posts(&store).is_empty());
        assert_eq!(
            store.interaction_rows().len(),
            2,
            "the like and repost are not under it"
        );
        assert_eq!(count(&store, "space_repo_record"), 4);
        assert!(
            stored_paths(&store, FAYE).contains_key(&(POST.to_owned(), "swordfish".to_owned()))
        );
    }

    #[test]
    fn every_record_of_a_member_under_an_account_takedown_is_not_projected() {
        let mut store = memory_store();
        take_down(
            &mut store,
            LabelSubject::Account {
                did: FAYE.to_owned(),
            },
        );
        // The takedown ends the membership; the service lists the member again.
        members(&mut store, &[FAYE]);

        promote_page(&mut store, &fixture_pages()[0]).unwrap();

        assert!(served_posts(&store).is_empty());
        assert!(store.interaction_rows().is_empty());
        assert_eq!(count(&store, "space_repo_record"), 4);
        assert_eq!(
            store.verified_space_base(SPACE, FAYE).unwrap().unwrap().rev,
            "3jzfcijpj2z2b"
        );
    }

    #[test]
    fn retention_leaves_the_path_rows_and_a_later_delete_still_promotes() {
        let mut store = memory_store();
        let pages = fixture_pages();
        promote_page(&mut store, &pages[0]).unwrap();
        assert_eq!(served_posts(&store).len(), 1);

        let removed = store
            .purge_expired("2026-09-24T00:00:00.000Z", 100)
            .unwrap();
        assert!(removed >= 1);
        assert!(served_posts(&store).is_empty());
        assert_eq!(
            count(&store, "space_repo_record"),
            4,
            "retention never deletes path rows"
        );
        assert_eq!(count(&store, "space_repo_state"), 1);

        let edited = stored_paths(&store, FAYE)[&(POST.to_owned(), "swordfish".to_owned())];
        let ops = json!([op(
            "3jzfcijpj2z2c",
            POST,
            "swordfish",
            None,
            Some(&edited),
            None
        )]);
        let mut model = stored_paths(&store, FAYE);
        model.remove(&(POST.to_owned(), "swordfish".to_owned()));
        let target = target_of(&store, FAYE);
        promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2c", &model),
            &ops,
        )
        .unwrap();

        assert_eq!(stored_paths(&store, FAYE), model);
    }

    // Budgets.

    fn follow_ops(range: std::ops::Range<usize>) -> Value {
        Value::Array(
            range
                .map(|index| {
                    let value =
                        json!({ "$type": FOLLOW, "subject": format!("did:plc:spike{index}") });
                    op(
                        "3jzfcijpj2z2a",
                        FOLLOW,
                        &format!("spike-{index}"),
                        Some(&cid_of(&value)),
                        None,
                        None,
                    )
                })
                .collect(),
        )
    }

    fn promote_follows(
        store: &mut EncryptedStore,
        range: std::ops::Range<usize>,
    ) -> Result<(), StoreError> {
        let target = target_of(store, FAYE);
        let ops = follow_ops(range);
        let mut model = stored_paths(store, FAYE);
        model_after(&mut model, &ops);
        promote_with(
            store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2a", &model),
            &ops,
        )
    }

    #[test]
    fn a_promotion_past_the_per_member_record_limit_is_refused_whole() {
        let mut store = memory_store();
        let limit = crate::config::MAX_SPACE_REPO_RECORDS;
        for start in (0..limit).step_by(1_000) {
            promote_follows(&mut store, start..start + 1_000).unwrap();
        }
        assert_eq!(count(&store, "space_repo_record"), limit as i64);
        let before = (
            store.verified_space_base(SPACE, FAYE).unwrap(),
            count(&store, "space_repo_record"),
        );

        let outcome = promote_follows(&mut store, limit..limit + 1);

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoOverBudget)),
            "{outcome:?}"
        );
        assert_eq!(
            (
                store.verified_space_base(SPACE, FAYE).unwrap(),
                count(&store, "space_repo_record")
            ),
            before
        );
    }

    #[test]
    fn a_promotion_past_the_store_wide_row_limit_is_refused_whole() {
        let mut store = memory_store();
        members(&mut store, &[FAYE, JET]);
        let other_rows = crate::config::MAX_SPACE_VERIFICATION_ROWS - 10;
        store
            .connection
            .execute(
                "INSERT INTO space_repo_state (space_uri, did, boundary, host, generation, rev, set_hash, record_count, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, '3jzfcijpj2z2a', zeroblob(2048), ?5, ?6)",
                params![SPACE, JET, BOUNDARY, HOST, other_rows as i64, OBSERVED],
            )
            .unwrap();

        promote_follows(&mut store, 0..10).unwrap();
        assert_eq!(count(&store, "space_repo_record"), 10);
        let before = snapshot(&store);

        let outcome = promote_follows(&mut store, 10..11);

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoOverBudget)),
            "{outcome:?}"
        );
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn more_changes_than_one_poll_may_carry_are_refused_whole() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);
        let ops = follow_ops(0..crate::space_sync::MAX_SPACE_PAGE_OPS + 1);
        let model = {
            let mut model = Model::new();
            model_after(&mut model, &ops);
            model
        };
        let change_set = {
            let (first, second) = ops
                .as_array()
                .unwrap()
                .split_at(crate::space_sync::MAX_SPACE_PAGE_OPS);
            let mut decoded =
                decode_op_page(&serde_json::to_vec(&json!({ "ops": first })).unwrap())
                    .unwrap()
                    .ops()
                    .to_vec();
            decoded.extend_from_slice(
                decode_op_page(&serde_json::to_vec(&json!({ "ops": second })).unwrap())
                    .unwrap()
                    .ops(),
            );
            ChangeSet::apply(SetHashState::empty(), &decoded).unwrap()
        };

        let outcome = store.promote_verified_space_repo(
            &target,
            None,
            &model_commit(FAYE, "3jzfcijpj2z2a", &model),
            &change_set,
            RETAINED,
            OBSERVED,
        );

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoOverBudget)),
            "{outcome:?}"
        );
        assert_eq!(count(&store, "space_repo_record"), 0);
        assert_eq!(count(&store, "space_repo_state"), 0);
    }

    // Crash safety on a file store.

    #[test]
    fn a_promotion_that_never_commits_leaves_nothing_and_a_full_one_survives_reopening() {
        let path = file_path("crash");
        let page = fixture_pages()[0].clone();
        {
            let mut store = EncryptedStore::open(&path, key()).unwrap();
            members(&mut store, &[FAYE]);
            let target = target_of(&store, FAYE);
            let change_set = change_set_over(&store, FAYE, &page["ops"]);
            let transaction = store
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            write_verified_promotion(
                &transaction,
                &target,
                None,
                &commit_of_page(&page),
                &change_set,
                RETAINED,
                OBSERVED,
            )
            .unwrap();
            let written: i64 = transaction
                .query_row("SELECT COUNT(*) FROM space_repo_record", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(written, 4, "the writes happened inside the transaction");
            drop(transaction);
        }

        {
            let mut store = EncryptedStore::open(&path, key()).unwrap();
            assert_eq!(store.verified_space_base(SPACE, FAYE).unwrap(), None);
            assert_eq!(count(&store, "space_repo_record"), 0);
            assert_eq!(count(&store, "post"), 0);
            assert_eq!(count(&store, "interaction"), 0);
            promote_page(&mut store, &page).unwrap();
        }

        let reopened = EncryptedStore::open(&path, key()).unwrap();
        let base = reopened.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(base.rev, "3jzfcijpj2z2b");
        assert_eq!(base.state.digest(), *commit_of_page(&page).data());
        assert_eq!(count(&reopened, "space_repo_record"), 4);
        assert_eq!(served_posts(&reopened).len(), 1);
        assert_eq!(reopened.interaction_rows().len(), 2);
        drop(reopened);
        fs::remove_file(path).unwrap();
    }

    // Purge hooks: each place that removes or resets a member's space state.

    fn two_promoted_members() -> EncryptedStore {
        let mut store = EncryptedStore::open_memory(key()).unwrap();
        members(&mut store, &[FAYE, JET]);
        promote_page(&mut store, &fixture_pages()[0]).unwrap();
        let target = target_of(&store, JET);
        let follow = json!([op(
            "3jzfcijpj2z2a",
            FOLLOW,
            "spike",
            Some(&cid_of(
                &json!({ "$type": FOLLOW, "subject": "did:plc:spikespiegel" })
            )),
            None,
            None
        )]);
        let mut model = Model::new();
        model_after(&mut model, &follow);
        promote_with(
            &mut store,
            &target,
            &model_commit(JET, "3jzfcijpj2z2a", &model),
            &follow,
        )
        .unwrap();
        assert_eq!(count(&store, "space_repo_state"), 2);
        store
    }

    fn assert_only_the_other_member_remains(store: &EncryptedStore) {
        assert_eq!(store.verified_space_base(SPACE, FAYE).unwrap(), None);
        assert!(stored_paths(store, FAYE).is_empty());
        assert!(store.verified_space_base(SPACE, JET).unwrap().is_some());
        assert_eq!(stored_paths(store, JET).len(), 1);
        assert_eq!(count(store, "space_repo_state"), 1);
        assert_eq!(count(store, "space_repo_record"), 1);
    }

    #[test]
    fn a_departed_member_loses_the_verified_state_and_the_other_member_keeps_it() {
        let mut store = two_promoted_members();
        members(&mut store, &[JET]);
        assert_only_the_other_member_remains(&store);
    }

    #[test]
    fn resetting_a_members_space_state_removes_the_verified_state() {
        let mut store = two_promoted_members();
        store.reset_pds_member_space_state(BOUNDARY, FAYE).unwrap();
        assert_only_the_other_member_remains(&store);
    }

    #[test]
    fn unenrolling_an_actor_removes_the_verified_state() {
        let mut store = two_promoted_members();
        store
            .reconcile_actor_enrollment(FAYE, OBSERVED, None)
            .unwrap();
        assert_only_the_other_member_remains(&store);
    }

    #[test]
    fn shrinking_an_enrollment_below_the_boundary_removes_the_verified_state() {
        let mut store = two_promoted_members();
        store
            .reconcile_actor_enrollment(
                FAYE,
                OBSERVED,
                Some(ActorEnrollment {
                    did: FAYE.to_owned(),
                    boundaries: vec!["did:web:bebop.example/other".to_owned()],
                    observed_at: OBSERVED.to_owned(),
                }),
            )
            .unwrap();
        assert_only_the_other_member_remains(&store);
    }

    const HAMMERHEAD: &str = "did:web:bebop.example/hammerhead";
    const HAMMERHEAD_SPACE: &str =
        "at:space/did:web:bebop.example/zone.stratos.space.feed/hammerhead";

    fn promote_swordfish_in(
        store: &mut EncryptedStore,
        boundary: &str,
        space_uri: &str,
        rkey: &str,
    ) {
        let value = post_value("see you space cowboy");
        let cid = cid_of(&value);
        let mut model = Model::new();
        model.insert((POST.to_owned(), rkey.to_owned()), cid);
        let commit =
            MacVerifiedCommit::for_tests(FAYE, space_uri, "3jzfcijpj2z2a", hashed(&model).digest());
        let ops = json!([create_post("3jzfcijpj2z2a", rkey, &value)]);
        let body = serde_json::to_vec(&json!({ "ops": ops })).unwrap();
        let change_set =
            ChangeSet::apply(SetHashState::empty(), decode_op_page(&body).unwrap().ops()).unwrap();
        let target = VerifiedSpaceTarget {
            boundary: boundary.to_owned(),
            space_uri: space_uri.to_owned(),
            actor_did: FAYE.to_owned(),
            host: HOST.to_owned(),
            generation: store
                .pds_member_generation(boundary, FAYE)
                .unwrap()
                .unwrap(),
        };
        store
            .promote_verified_space_repo(&target, None, &commit, &change_set, RETAINED, OBSERVED)
            .unwrap();
    }

    fn rows_of_space(store: &EncryptedStore, table: &str, space_uri: &str) -> i64 {
        store
            .connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE space_uri = ?1"),
                [space_uri],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn purging_a_boundary_removes_its_verified_state_and_leaves_the_members_other_boundary() {
        let mut store = memory_store();
        store
            .replace_pds_space_members(
                HAMMERHEAD,
                vec![PdsSpaceMember {
                    did: FAYE.to_owned(),
                }],
                OBSERVED,
            )
            .unwrap();
        promote_swordfish_in(&mut store, BOUNDARY, SPACE, "swordfish");
        promote_swordfish_in(&mut store, HAMMERHEAD, HAMMERHEAD_SPACE, "ein");
        let kept = snapshot(&store);
        assert_eq!(kept.2.len(), 1);
        assert_eq!(
            rows_of_space(&store, "space_repo_record", HAMMERHEAD_SPACE),
            1
        );

        store.purge_boundary(HAMMERHEAD).unwrap();

        assert_eq!(snapshot(&store), kept);
        assert_eq!(rows_of_space(&store, "space_repo_state", SPACE), 1);
        assert_eq!(rows_of_space(&store, "space_repo_record", SPACE), 1);
        assert_eq!(
            rows_of_space(&store, "space_repo_state", HAMMERHEAD_SPACE),
            0
        );
        assert_eq!(
            rows_of_space(&store, "space_repo_record", HAMMERHEAD_SPACE),
            0
        );
        assert!(
            store
                .list_posts_by_boundary(HAMMERHEAD, None, 50, AS_OF)
                .unwrap()
                .posts
                .is_empty()
        );
        assert!(
            store
                .verified_space_base(HAMMERHEAD_SPACE, FAYE)
                .unwrap()
                .is_none()
        );
    }

    // Whole-repo replacement.

    const LIKE: &str = "app.bsky.feed.like";
    const REPOST: &str = "app.bsky.feed.repost";

    fn record_of(collection: &str, rkey: &str, value: &Value) -> VerifiedSpaceRecord {
        VerifiedSpaceRecord {
            path: RecordPath::parse(collection, rkey).unwrap(),
            cid: cid_of(value),
            value: value.clone(),
        }
    }

    fn sorted(mut records: Vec<VerifiedSpaceRecord>) -> Vec<VerifiedSpaceRecord> {
        records.sort_by(|left, right| {
            (left.path.collection(), left.path.rkey())
                .cmp(&(right.path.collection(), right.path.rkey()))
        });
        records
    }

    fn digest_of(records: &[VerifiedSpaceRecord]) -> [u8; 32] {
        let mut state = SetHashState::empty();
        for record in records {
            state.add(&set_hash_element(&record.path, &record.cid));
        }
        state.digest()
    }

    fn commit_for(
        did: &str,
        space: &str,
        rev: &str,
        records: &[VerifiedSpaceRecord],
    ) -> MacVerifiedCommit {
        MacVerifiedCommit::for_tests(did, space, rev, digest_of(records))
    }

    fn replace(
        store: &mut EncryptedStore,
        target: &VerifiedSpaceTarget,
        commit: &MacVerifiedCommit,
        records: &[VerifiedSpaceRecord],
    ) -> Result<(), StoreError> {
        store.replace_verified_space_repo(target, commit, records, RETAINED, OBSERVED)
    }

    fn replace_faye(
        store: &mut EncryptedStore,
        commit: &MacVerifiedCommit,
        records: &[VerifiedSpaceRecord],
    ) -> Result<(), StoreError> {
        let target = target_of(store, FAYE);
        replace(store, &target, commit, records)
    }

    fn subject_like() -> Value {
        json!({
            "$type": LIKE,
            "subject": {
                "uri": "at://did:plc:fayevalentine/zone.stratos.feed.post/swordfish",
                "cid": "bafyreihypg3uvx3sc754r22emkw6ujpiqjozie6puum4ie4egt2jqxz6wa"
            }
        })
    }

    fn subject_repost() -> Value {
        json!({
            "$type": REPOST,
            "subject": {
                "uri": "at://did:plc:fayevalentine/zone.stratos.feed.post/swordfish",
                "cid": "bafyreihypg3uvx3sc754r22emkw6ujpiqjozie6puum4ie4egt2jqxz6wa"
            }
        })
    }

    fn faye_before_replacement() -> Vec<VerifiedSpaceRecord> {
        sorted(vec![
            record_of(POST, "swordfish", &post_value("See you space cowboy")),
            record_of(POST, "ein", &post_value("Woof")),
            record_of(LIKE, "ed", &subject_like()),
            record_of(REPOST, "jet", &subject_repost()),
        ])
    }

    fn promote_records(
        store: &mut EncryptedStore,
        target: &VerifiedSpaceTarget,
        rev: &str,
        records: &[VerifiedSpaceRecord],
    ) {
        let ops: Vec<Value> = records
            .iter()
            .map(|record| {
                op(
                    rev,
                    record.path.collection(),
                    record.path.rkey(),
                    Some(&record.cid),
                    None,
                    Some(&record.value),
                )
            })
            .collect();
        promote_with(
            store,
            target,
            &commit_for(&target.actor_did, &target.space_uri, rev, records),
            &Value::Array(ops),
        )
        .unwrap();
    }

    fn dump(store: &EncryptedStore, sql: &str, parameter: &str) -> Vec<String> {
        let mut statement = store.connection.prepare(sql).unwrap();
        let columns = statement.column_count();
        statement
            .query_map([parameter], |row| {
                Ok((0..columns)
                    .map(|column| format!("{:?}", row.get_ref(column).unwrap()))
                    .collect::<Vec<_>>()
                    .join("|"))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn rows_of_member(store: &EncryptedStore, did: &str) -> Vec<Vec<String>> {
        [
            "SELECT * FROM post WHERE author_did = ?1 ORDER BY uri",
            "SELECT * FROM post_boundary WHERE uri IN (SELECT uri FROM post WHERE author_did = ?1) ORDER BY uri",
            "SELECT * FROM interaction WHERE actor_did = ?1 ORDER BY uri",
            "SELECT * FROM space_repo_state WHERE did = ?1 ORDER BY space_uri",
            "SELECT * FROM space_repo_record WHERE did = ?1 ORDER BY space_uri, collection, rkey",
        ]
        .iter()
        .map(|sql| dump(store, sql, did))
        .collect()
    }

    fn rows_in_space(store: &EncryptedStore, space_uri: &str) -> Vec<Vec<String>> {
        [
            "SELECT * FROM space_repo_state WHERE space_uri = ?1 ORDER BY did",
            "SELECT * FROM space_repo_record WHERE space_uri = ?1 ORDER BY did, collection, rkey",
            "SELECT * FROM post WHERE substr(uri, 1, length(?1) + 1) = ?1 || '/' ORDER BY uri",
            "SELECT * FROM interaction WHERE substr(uri, 1, length(?1) + 1) = ?1 || '/' ORDER BY uri",
        ]
        .iter()
        .map(|sql| dump(store, sql, space_uri))
        .collect()
    }

    fn custody_rows_of_faye(store: &mut EncryptedStore) {
        let post_uri = format!("at://{FAYE}/{POST}/custody");
        store
            .apply_actor_page(crate::store::ActorPage {
                authority_did: AUTHORITY.to_owned(),
                actor_did: FAYE.to_owned(),
                sequence: 1,
                upserts: vec![crate::store::ProjectionPost {
                    uri: post_uri.clone(),
                    author_did: FAYE.to_owned(),
                    cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                    sort_at: OBSERVED.to_owned(),
                    indexed_at: OBSERVED.to_owned(),
                    retained_at: RETAINED.to_owned(),
                    record_json: br#"{"text":"Bang"}"#.to_vec(),
                    blob_refs_json: b"[]".to_vec(),
                    boundaries: vec![BOUNDARY.to_owned()],
                }],
                deletes: Vec::new(),
                interactions: crate::store::InteractionChanges {
                    upserts: vec![crate::store::ProjectionInteraction {
                        uri: format!("at://{FAYE}/{LIKE}/custody"),
                        actor_did: FAYE.to_owned(),
                        kind: crate::store::InteractionKind::Like,
                        subject_uri: post_uri,
                        boundary: BOUNDARY.to_owned(),
                        indexed_at: OBSERVED.to_owned(),
                        retained_at: RETAINED.to_owned(),
                    }],
                    deletes: Vec::new(),
                },
                updated_at: OBSERVED.to_owned(),
            })
            .unwrap();
    }

    fn custody_rows(store: &EncryptedStore) -> Vec<String> {
        let mut rows = dump(
            store,
            "SELECT * FROM post WHERE uri = ?1 || '/zone.stratos.feed.post/custody'",
            &format!("at://{FAYE}"),
        );
        rows.extend(dump(
            store,
            "SELECT * FROM interaction WHERE uri = ?1 || '/app.bsky.feed.like/custody'",
            &format!("at://{FAYE}"),
        ));
        rows
    }

    #[test]
    fn a_replacement_removes_what_the_set_no_longer_holds_and_leaves_everything_else_alone() {
        let mut store = memory_store();
        members(&mut store, &[FAYE, JET]);
        store
            .replace_pds_space_members(
                HAMMERHEAD,
                vec![PdsSpaceMember {
                    did: FAYE.to_owned(),
                }],
                OBSERVED,
            )
            .unwrap();
        let target = target_of(&store, FAYE);
        promote_records(
            &mut store,
            &target,
            "3jzfcijpj2z2a",
            &faye_before_replacement(),
        );
        promote_swordfish_in(&mut store, HAMMERHEAD, HAMMERHEAD_SPACE, "swordfish");
        let jet_target = target_of(&store, JET);
        promote_records(
            &mut store,
            &jet_target,
            "3jzfcijpj2z2a",
            &sorted(vec![
                record_of(POST, "swordfish", &post_value("Bang")),
                record_of(LIKE, "ed", &subject_like()),
            ]),
        );
        custody_rows_of_faye(&mut store);
        assert_eq!(
            served_posts(&store).len(),
            4,
            "faye twice, jet once, one custody"
        );
        assert_eq!(
            store.interaction_rows().len(),
            3 + 1,
            "two of faye's, one of jet's, one custody"
        );
        let jet_before = rows_of_member(&store, JET);
        let other_space_before = rows_in_space(&store, HAMMERHEAD_SPACE);
        let custody_before = custody_rows(&store);
        assert_eq!(custody_before.len(), 2);

        let kept = sorted(vec![
            record_of(POST, "ein", &post_value("Woof")),
            record_of(REPOST, "jet", &subject_repost()),
        ]);
        replace(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2c", &kept),
            &kept,
        )
        .unwrap();

        let served: Vec<String> = served_posts(&store)
            .into_iter()
            .map(|(uri, _)| uri)
            .collect();
        assert!(served.contains(&record_uri(FAYE, POST, "ein")));
        assert!(!served.contains(&record_uri(FAYE, POST, "swordfish")));
        let interactions: Vec<String> = store
            .interaction_rows()
            .into_iter()
            .map(|row| row.0)
            .collect();
        assert!(interactions.contains(&record_uri(FAYE, REPOST, "jet")));
        assert!(
            !interactions.contains(&record_uri(FAYE, LIKE, "ed")),
            "the like the set dropped is gone"
        );
        assert_eq!(
            stored_paths(&store, FAYE)
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            kept.iter()
                .map(|record| (
                    record.path.collection().to_owned(),
                    record.path.rkey().to_owned()
                ))
                .collect::<Vec<_>>()
        );
        let base = store.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(base.rev, "3jzfcijpj2z2c");
        assert_eq!(base.record_count, 2);
        assert_eq!(base.state.digest(), digest_of(&kept));

        assert_eq!(rows_of_member(&store, JET), jet_before);
        assert_eq!(rows_in_space(&store, HAMMERHEAD_SPACE), other_space_before);
        assert_eq!(custody_rows(&store), custody_before);
    }

    #[test]
    fn replacing_from_the_final_fixture_state_stores_the_oracles_state_and_digest() {
        let mut store = memory_store();
        let pages = fixture_pages();
        let mut last: BTreeMap<(String, String), Value> = BTreeMap::new();
        for op in pages
            .iter()
            .flat_map(|page| page["ops"].as_array().unwrap())
        {
            let path = (
                op["collection"].as_str().unwrap().to_owned(),
                op["rkey"].as_str().unwrap().to_owned(),
            );
            match op.get("value") {
                Some(value) if op["cid"].is_string() => last.insert(path, value.clone()),
                _ => last.remove(&path),
            };
        }
        let records: Vec<VerifiedSpaceRecord> = last
            .iter()
            .map(|((collection, rkey), value)| record_of(collection, rkey, value))
            .collect();
        let last_page = pages.last().unwrap();
        assert_eq!(records.len(), 4);

        replace_faye(&mut store, &commit_of_page(last_page), &records).unwrap();

        let fixture: Value = serde_json::from_str(OP_PAGES).unwrap();
        let final_state = STANDARD
            .decode(fixture["stateAfterLastPage"]["value"].as_str().unwrap())
            .unwrap();
        let stored = store.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(stored.state.to_bytes().as_slice(), final_state.as_slice());
        assert_eq!(stored.state.digest(), *commit_of_page(last_page).data());
        assert_eq!(stored.rev, last_page["commit"]["rev"].as_str().unwrap());
        assert_eq!(stored.host, HOST);
        assert_eq!(stored.record_count, 4);
        let served: Vec<String> = served_posts(&store)
            .into_iter()
            .map(|(uri, _)| uri)
            .collect();
        assert_eq!(
            served,
            vec![
                record_uri(FAYE, POST, "ein"),
                record_uri(FAYE, POST, "swordfish")
            ]
        );
        assert_eq!(store.interaction_rows().len(), 1);
    }

    #[test]
    fn an_empty_set_with_the_empty_digest_clears_the_member_and_stores_the_checkpoint() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);
        promote_records(
            &mut store,
            &target,
            "3jzfcijpj2z2a",
            &faye_before_replacement(),
        );
        assert_eq!(served_posts(&store).len(), 2);

        replace(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &[]),
            &[],
        )
        .unwrap();

        assert!(served_posts(&store).is_empty());
        assert!(store.interaction_rows().is_empty());
        assert!(stored_paths(&store, FAYE).is_empty());
        let base = store.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(base.rev, "3jzfcijpj2z2b");
        assert_eq!(base.record_count, 0);
        assert_eq!(base.state, SetHashState::empty());
    }

    #[test]
    fn an_empty_set_is_held_to_the_digest_too() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);
        promote_records(
            &mut store,
            &target,
            "3jzfcijpj2z2a",
            &faye_before_replacement(),
        );
        let before = rows_of_member(&store, FAYE);
        let not_empty = MacVerifiedCommit::for_tests(
            FAYE,
            SPACE,
            "3jzfcijpj2z2b",
            digest_of(&faye_before_replacement()),
        );

        let outcome = replace(&mut store, &target, &not_empty, &[]);

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoDigestMismatch)),
            "{outcome:?}"
        );
        assert_eq!(rows_of_member(&store, FAYE), before);
    }

    #[test]
    fn a_member_with_no_checkpoint_can_be_replaced_from_nothing() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);

        replace(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2a", &[]),
            &[],
        )
        .unwrap();

        let base = store.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(base.record_count, 0);
        assert_eq!(count(&store, "space_repo_record"), 0);
    }

    fn assert_refused_and_unchanged(
        store: &mut EncryptedStore,
        target: &VerifiedSpaceTarget,
        commit: &MacVerifiedCommit,
        records: &[VerifiedSpaceRecord],
    ) -> StoreError {
        let before = (rows_of_member(store, FAYE), rows_of_member(store, JET));
        let outcome = replace(store, target, commit, records);
        assert_eq!(
            (rows_of_member(store, FAYE), rows_of_member(store, JET)),
            before
        );
        outcome.expect_err("the replacement must be refused")
    }

    fn store_with_faye_and_jet_promoted() -> (EncryptedStore, VerifiedSpaceTarget) {
        let mut store = memory_store();
        members(&mut store, &[FAYE, JET]);
        let target = target_of(&store, FAYE);
        promote_records(
            &mut store,
            &target,
            "3jzfcijpj2z2a",
            &faye_before_replacement(),
        );
        let jet = target_of(&store, JET);
        promote_records(
            &mut store,
            &jet,
            "3jzfcijpj2z2a",
            &[record_of(POST, "swordfish", &post_value("Bang"))],
        );
        (store, target)
    }

    #[test]
    fn a_wrong_digest_changes_nothing() {
        let (mut store, target) = store_with_faye_and_jet_promoted();
        let replacement = sorted(vec![record_of(POST, "ein", &post_value("Woof"))]);
        let other_set = sorted(vec![record_of(POST, "ein", &post_value("Woof, woof"))]);

        let error = assert_refused_and_unchanged(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &other_set),
            &replacement,
        );

        assert!(
            matches!(error, StoreError::SpaceRepoDigestMismatch),
            "{error:?}"
        );
    }

    #[test]
    fn a_stale_generation_changes_nothing() {
        let (mut store, target) = store_with_faye_and_jet_promoted();
        members(&mut store, &[JET]);
        members(&mut store, &[FAYE, JET]);
        let replacement = sorted(vec![record_of(POST, "ein", &post_value("Woof"))]);
        let before = (
            rows_of_member(&store, JET),
            count(&store, "space_repo_record"),
        );

        let outcome = replace(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &replacement),
            &replacement,
        );

        assert!(
            matches!(outcome, Err(StoreError::UnauthorizedSpaceMember)),
            "{outcome:?}"
        );
        assert_eq!(
            (
                rows_of_member(&store, JET),
                count(&store, "space_repo_record")
            ),
            before
        );
    }

    #[test]
    fn a_member_who_left_cannot_be_replaced() {
        let (mut store, target) = store_with_faye_and_jet_promoted();
        let jet_before = rows_of_member(&store, JET);
        members(&mut store, &[JET]);

        let outcome = replace(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &[]),
            &[],
        );

        assert!(
            matches!(outcome, Err(StoreError::UnauthorizedSpaceMember)),
            "{outcome:?}"
        );
        assert_eq!(store.verified_space_base(SPACE, FAYE).unwrap(), None);
        assert_eq!(rows_of_member(&store, JET), jet_before);
    }

    #[test]
    fn a_commit_for_another_repo_or_space_changes_nothing() {
        let (mut store, target) = store_with_faye_and_jet_promoted();
        let replacement = sorted(vec![record_of(POST, "ein", &post_value("Woof"))]);
        for commit in [
            commit_for(JET, SPACE, "3jzfcijpj2z2b", &replacement),
            commit_for(FAYE, HAMMERHEAD_SPACE, "3jzfcijpj2z2b", &replacement),
        ] {
            let error = assert_refused_and_unchanged(&mut store, &target, &commit, &replacement);
            assert!(matches!(error, StoreError::SpaceRepoInvalid), "{error:?}");
        }
    }

    #[test]
    fn duplicate_or_unsorted_paths_are_refused_even_with_the_right_digest() {
        let (mut store, target) = store_with_faye_and_jet_promoted();
        let ein = record_of(POST, "ein", &post_value("Woof"));
        let swordfish = record_of(POST, "swordfish", &post_value("Bang"));
        for records in [
            vec![ein.clone(), ein.clone()],
            vec![swordfish.clone(), ein.clone()],
        ] {
            let error = assert_refused_and_unchanged(
                &mut store,
                &target,
                &MacVerifiedCommit::for_tests(FAYE, SPACE, "3jzfcijpj2z2b", digest_of(&records)),
                &records,
            );
            assert!(matches!(error, StoreError::SpaceRepoInvalid), "{error:?}");
        }
    }

    #[test]
    fn a_record_that_is_not_the_one_its_cid_names_refuses_the_whole_replacement() {
        let (mut store, target) = store_with_faye_and_jet_promoted();
        let mut forged = record_of(POST, "swordfish", &post_value("Bang"));
        forged.value = post_value("Bang, edited");
        let records = sorted(vec![record_of(POST, "ein", &post_value("Woof")), forged]);

        let error = assert_refused_and_unchanged(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &records),
            &records,
        );

        assert!(matches!(error, StoreError::SpaceRepoInvalid), "{error:?}");
    }

    #[test]
    fn a_record_the_encoder_refuses_refuses_the_whole_replacement() {
        let (mut store, target) = store_with_faye_and_jet_promoted();
        let fractional = json!({ "$type": POST, "text": "Woof", "volume": 1.5 });
        let records = sorted(vec![
            record_of(POST, "swordfish", &post_value("Bang")),
            VerifiedSpaceRecord {
                path: RecordPath::parse(POST, "ein").unwrap(),
                cid: cid_of(&post_value("Woof")),
                value: fractional,
            },
        ]);

        let error = assert_refused_and_unchanged(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &records),
            &records,
        );

        assert!(matches!(error, StoreError::SpaceRepoInvalid), "{error:?}");
    }

    #[test]
    fn a_record_under_a_takedown_in_the_set_is_not_projected_and_keeps_its_path_row() {
        let mut store = memory_store();
        take_down(
            &mut store,
            LabelSubject::Record {
                uri: record_uri(FAYE, POST, "swordfish"),
                author_did: FAYE.to_owned(),
            },
        );
        let records = faye_before_replacement();

        replace_faye(
            &mut store,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2a", &records),
            &records,
        )
        .unwrap();

        let served: Vec<String> = served_posts(&store)
            .into_iter()
            .map(|(uri, _)| uri)
            .collect();
        assert_eq!(served, vec![record_uri(FAYE, POST, "ein")]);
        assert_eq!(store.interaction_rows().len(), 2);
        assert!(
            stored_paths(&store, FAYE).contains_key(&(POST.to_owned(), "swordfish".to_owned()))
        );
    }

    #[test]
    fn a_replacement_under_an_account_takedown_projects_nothing() {
        let mut store = memory_store();
        take_down(
            &mut store,
            LabelSubject::Account {
                did: FAYE.to_owned(),
            },
        );
        members(&mut store, &[FAYE]);
        let records = faye_before_replacement();

        replace_faye(
            &mut store,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2a", &records),
            &records,
        )
        .unwrap();

        assert!(served_posts(&store).is_empty());
        assert!(store.interaction_rows().is_empty());
        assert_eq!(stored_paths(&store, FAYE).len(), 4);
    }

    #[test]
    fn a_record_that_stops_being_admissible_is_removed_by_the_replacement() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);
        promote_records(
            &mut store,
            &target,
            "3jzfcijpj2z2a",
            &faye_before_replacement(),
        );
        let impostor = json!({ "$type": "app.bsky.feed.post", "text": "See you space cowboy" });
        let records = sorted(vec![
            record_of(POST, "swordfish", &impostor),
            record_of(POST, "ein", &post_value("Woof")),
        ]);

        replace(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &records),
            &records,
        )
        .unwrap();

        let served: Vec<String> = served_posts(&store)
            .into_iter()
            .map(|(uri, _)| uri)
            .collect();
        assert_eq!(served, vec![record_uri(FAYE, POST, "ein")]);
        assert_eq!(stored_paths(&store, FAYE).len(), 2);
    }

    #[test]
    fn the_boundary_of_a_replacement_is_the_targets_whatever_the_record_claims() {
        let mut store = memory_store();
        let forged = json!({
            "$type": POST,
            "text": "See you space cowboy",
            "boundary": { "values": ["did:web:bebop.example/forged"] }
        });
        let records = vec![record_of(POST, "swordfish", &forged)];

        replace_faye(
            &mut store,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2a", &records),
            &records,
        )
        .unwrap();

        let boundaries: Vec<String> = store
            .connection
            .prepare("SELECT boundary FROM post_boundary UNION ALL SELECT boundary FROM space_repo_record UNION ALL SELECT boundary FROM space_repo_state")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(boundaries, vec![BOUNDARY.to_owned(); 3]);
    }

    #[test]
    fn a_replacement_takes_over_the_stored_host_and_generation() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);
        promote_records(
            &mut store,
            &target,
            "3jzfcijpj2z2a",
            &faye_before_replacement(),
        );
        store
            .connection
            .execute(
                "UPDATE space_repo_state SET generation = generation + 5 WHERE did = ?1",
                [FAYE],
            )
            .unwrap();
        let stored = store.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(stored.host, HOST);
        assert_ne!(stored.generation, target.generation);
        let moved = VerifiedSpaceTarget {
            host: "https://pds.redtail.example".to_owned(),
            ..target
        };
        let records = faye_before_replacement();

        replace(
            &mut store,
            &moved,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &records),
            &records,
        )
        .unwrap();

        let base = store.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(base.host, "https://pds.redtail.example");
        assert_eq!(base.generation, moved.generation);
    }

    #[test]
    fn an_incremental_promotion_works_from_the_revision_a_replacement_left() {
        let mut store = memory_store();
        let target = target_of(&store, FAYE);
        let records = faye_before_replacement();
        replace(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &records),
            &records,
        )
        .unwrap();

        let barking = post_value("Woof, woof");
        let ein = cid_of(&post_value("Woof"));
        let ops = json!([op(
            "3jzfcijpj2z2c",
            POST,
            "ein",
            Some(&cid_of(&barking)),
            Some(&ein),
            Some(&barking)
        )]);
        let mut model: Model = records
            .iter()
            .map(|record| {
                (
                    (
                        record.path.collection().to_owned(),
                        record.path.rkey().to_owned(),
                    ),
                    record.cid,
                )
            })
            .collect();
        model_after(&mut model, &ops);

        promote_with(
            &mut store,
            &target,
            &model_commit(FAYE, "3jzfcijpj2z2c", &model),
            &ops,
        )
        .unwrap();

        assert_eq!(
            store.verified_space_base(SPACE, FAYE).unwrap().unwrap().rev,
            "3jzfcijpj2z2c"
        );
        assert_eq!(stored_paths(&store, FAYE), model);
    }

    #[test]
    fn a_set_past_the_per_member_record_limit_is_refused_before_anything_is_hashed() {
        let (mut store, target) = store_with_faye_and_jet_promoted();
        let follow = json!({ "$type": FOLLOW, "subject": "did:plc:spikespiegel" });
        let records: Vec<VerifiedSpaceRecord> = (0..=MAX_SPACE_REPO_RECORDS)
            .map(|index| record_of(FOLLOW, &format!("f{index:06}"), &follow))
            .collect();

        let error = assert_refused_and_unchanged(
            &mut store,
            &target,
            &MacVerifiedCommit::for_tests(FAYE, SPACE, "3jzfcijpj2z2b", [0; 32]),
            &records,
        );

        assert!(
            matches!(error, StoreError::SpaceRepoOverBudget),
            "{error:?}"
        );
    }

    #[test]
    fn a_set_past_the_store_wide_row_limit_is_refused_whole() {
        let mut store = memory_store();
        members(&mut store, &[FAYE, JET]);
        let other_rows = crate::config::MAX_SPACE_VERIFICATION_ROWS - 3;
        store
            .connection
            .execute(
                "INSERT INTO space_repo_state (space_uri, did, boundary, host, generation, rev, set_hash, record_count, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, '3jzfcijpj2z2a', zeroblob(2048), ?5, ?6)",
                params![SPACE, JET, BOUNDARY, HOST, other_rows as i64, OBSERVED],
            )
            .unwrap();
        let target = target_of(&store, FAYE);
        let fits = sorted(vec![
            record_of(POST, "swordfish", &post_value("Bang")),
            record_of(POST, "ein", &post_value("Woof")),
            record_of(POST, "spike", &post_value("Whatever happens, happens")),
        ]);
        replace(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2a", &fits),
            &fits,
        )
        .unwrap();
        let before = rows_of_member(&store, FAYE);
        let one_too_many = sorted(vec![
            record_of(POST, "swordfish", &post_value("Bang")),
            record_of(POST, "ein", &post_value("Woof")),
            record_of(POST, "spike", &post_value("Whatever happens, happens")),
            record_of(POST, "jet", &post_value("Bang bang")),
        ]);

        let outcome = replace(
            &mut store,
            &target,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &one_too_many),
            &one_too_many,
        );

        assert!(
            matches!(outcome, Err(StoreError::SpaceRepoOverBudget)),
            "{outcome:?}"
        );
        assert_eq!(rows_of_member(&store, FAYE), before);
    }

    #[test]
    fn a_replacement_that_never_commits_leaves_the_earlier_state_and_a_full_one_survives_reopening()
    {
        let path = file_path("replace-crash");
        let before;
        let replacement = sorted(vec![record_of(POST, "ein", &post_value("Woof"))]);
        {
            let mut store = EncryptedStore::open(&path, key()).unwrap();
            members(&mut store, &[FAYE]);
            let target = target_of(&store, FAYE);
            promote_records(
                &mut store,
                &target,
                "3jzfcijpj2z2a",
                &faye_before_replacement(),
            );
            before = rows_of_member(&store, FAYE);
            let transaction = store
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            write_verified_replacement(
                &transaction,
                &target,
                &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &replacement),
                &replacement,
                RETAINED,
                OBSERVED,
            )
            .unwrap();
            let written: i64 = transaction
                .query_row("SELECT COUNT(*) FROM space_repo_record", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(written, 1, "the writes happened inside the transaction");
            drop(transaction);
        }

        {
            let mut store = EncryptedStore::open(&path, key()).unwrap();
            assert_eq!(rows_of_member(&store, FAYE), before);
            assert_eq!(served_posts(&store).len(), 2);
            replace_faye(
                &mut store,
                &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &replacement),
                &replacement,
            )
            .unwrap();
        }

        let reopened = EncryptedStore::open(&path, key()).unwrap();
        let base = reopened.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(base.rev, "3jzfcijpj2z2b");
        assert_eq!(base.state.digest(), digest_of(&replacement));
        assert_eq!(count(&reopened, "space_repo_record"), 1);
        assert_eq!(served_posts(&reopened).len(), 1);
        assert!(reopened.interaction_rows().is_empty());
        drop(reopened);
        fs::remove_file(path).unwrap();
    }

    // Real store: the boundary `did:web:bebop.example/crew` names only the crew
    // feed space of that authority. Records read from any other space would be
    // served to crew viewers under the crew boundary.

    const SPACES_THE_BOUNDARY_DOES_NOT_NAME: [&str; 3] = [
        "at:space/did:web:bebop.example/zone.stratos.space.feed/bridge",
        "at:space/did:web:red-tail.example/zone.stratos.space.feed/crew",
        "at:space/did:web:bebop.example/zone.stratos.space.chat/crew",
    ];

    fn every_row(store: &EncryptedStore) -> Vec<(String, Vec<String>)> {
        let tables: Vec<String> = store
            .connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        tables
            .into_iter()
            .map(|table| {
                let mut statement = store
                    .connection
                    .prepare(&format!("SELECT * FROM \"{table}\""))
                    .unwrap();
                let columns = statement.column_count();
                let mut rows: Vec<String> = statement
                    .query_map([], |row| {
                        Ok((0..columns)
                            .map(|column| format!("{:?}", row.get_ref(column).unwrap()))
                            .collect::<Vec<_>>()
                            .join("|"))
                    })
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                rows.sort();
                (table, rows)
            })
            .collect()
    }

    fn faye_in(store: &EncryptedStore, space_uri: &str) -> VerifiedSpaceTarget {
        VerifiedSpaceTarget {
            space_uri: space_uri.to_owned(),
            ..target_of(store, FAYE)
        }
    }

    fn refused_with_nothing_changed() -> Vec<(&'static str, String, bool)> {
        SPACES_THE_BOUNDARY_DOES_NOT_NAME
            .iter()
            .map(|space_uri| (*space_uri, "Err(SpaceRepoInvalid)".to_owned(), true))
            .collect()
    }

    fn promote_from_nothing(
        store: &mut EncryptedStore,
        target: &VerifiedSpaceTarget,
        records: &[VerifiedSpaceRecord],
    ) -> Result<(), StoreError> {
        let rev = "3jzfcijpj2z2a";
        let ops: Vec<Value> = records
            .iter()
            .map(|record| {
                op(
                    rev,
                    record.path.collection(),
                    record.path.rkey(),
                    Some(&record.cid),
                    None,
                    Some(&record.value),
                )
            })
            .collect();
        let body = serde_json::to_vec(&json!({ "ops": ops })).unwrap();
        let change_set =
            ChangeSet::apply(SetHashState::empty(), decode_op_page(&body).unwrap().ops()).unwrap();
        store.promote_verified_space_repo(
            target,
            None,
            &commit_for(&target.actor_did, &target.space_uri, rev, records),
            &change_set,
            RETAINED,
            OBSERVED,
        )
    }

    #[test]
    fn a_promotion_into_a_space_the_boundary_does_not_name_is_refused_and_changes_nothing() {
        let mut store = memory_store();
        members(&mut store, &[FAYE, JET]);
        let jet = target_of(&store, JET);
        promote_records(
            &mut store,
            &jet,
            "3jzfcijpj2z2a",
            &[record_of(POST, "swordfish", &post_value("Bang"))],
        );
        let records = faye_before_replacement();
        let before = every_row(&store);

        let mut verdicts = Vec::new();
        for space_uri in SPACES_THE_BOUNDARY_DOES_NOT_NAME {
            let target = faye_in(&store, space_uri);
            let outcome = promote_from_nothing(&mut store, &target, &records);
            verdicts.push((
                space_uri,
                format!("{outcome:?}"),
                every_row(&store) == before,
            ));
        }
        assert_eq!(verdicts, refused_with_nothing_changed());

        let target = target_of(&store, FAYE);
        promote_from_nothing(&mut store, &target, &records).unwrap();
        let base = store.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(base.record_count, 4);
        assert_eq!(served_posts(&store).len(), 3);
    }

    #[test]
    fn a_replacement_into_a_space_the_boundary_does_not_name_is_refused_and_changes_nothing() {
        let (mut store, faye) = store_with_faye_and_jet_promoted();
        let replacement = sorted(vec![record_of(POST, "ein", &post_value("Woof"))]);
        let before = every_row(&store);

        let mut verdicts = Vec::new();
        for space_uri in SPACES_THE_BOUNDARY_DOES_NOT_NAME {
            let target = faye_in(&store, space_uri);
            let outcome = replace(
                &mut store,
                &target,
                &commit_for(FAYE, space_uri, "3jzfcijpj2z2b", &replacement),
                &replacement,
            );
            verdicts.push((
                space_uri,
                format!("{outcome:?}"),
                every_row(&store) == before,
            ));
        }
        assert_eq!(verdicts, refused_with_nothing_changed());

        replace(
            &mut store,
            &faye,
            &commit_for(FAYE, SPACE, "3jzfcijpj2z2b", &replacement),
            &replacement,
        )
        .unwrap();
        let base = store.verified_space_base(SPACE, FAYE).unwrap().unwrap();
        assert_eq!(base.rev, "3jzfcijpj2z2b");
        assert_eq!(base.record_count, 1);
    }

    #[test]
    fn a_space_the_boundary_does_not_name_is_refused_before_the_generation_is_read() {
        let mut store = memory_store();
        let mut target = faye_in(&store, SPACES_THE_BOUNDARY_DOES_NOT_NAME[0]);
        target.generation += 1;
        let records = faye_before_replacement();

        let promoted = promote_from_nothing(&mut store, &target, &records);
        let replaced = replace(
            &mut store,
            &target,
            &commit_for(FAYE, &target.space_uri, "3jzfcijpj2z2a", &records),
            &records,
        );

        assert!(
            matches!(promoted, Err(StoreError::SpaceRepoInvalid)),
            "{promoted:?}"
        );
        assert!(
            matches!(replaced, Err(StoreError::SpaceRepoInvalid)),
            "{replaced:?}"
        );
    }
}

//! An in-process space host for the synchronizer's tests. It keeps a repo per
//! member, answers `listRepoOps` pages and `getRepo` archives from it, and
//! signs every commit the way a host does, deriving the MAC secret with the
//! code under test: it proves the flow, not the cryptography.

use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use cid::Cid;
use hmac::{Hmac, Mac};
use p256::{SecretKey, elliptic_curve::sec1::ToEncodedPoint};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::{sync::Notify, time::Instant};

use super::{PageRequest, VerifiedSpaceReader, VerifiedSpaceReaderSource};
use crate::{
    membership_reconciler::PdsPollTarget,
    space_archive::REPO_ARCHIVE_TYPE,
    space_credential::HeldSpaceCredential,
    space_host::{
        ArchiveBody, AuthenticatedArchive, AuthenticatedPage, AuthenticatedReadError,
        RepoArchiveQuery, RepoArchiveTransport, RepoOpsQuery, RepoOpsTransport,
        SignedArchiveResponse, SignedReadResponse, SpaceHostError, authenticated_archive_read,
        authenticated_read,
    },
    space_identity::{AuthorKemKeyResolver, KemKeyLookupError},
    space_kem::{AuthorKemKey, decapsulate},
    space_mac::CommitResponseHeaders,
    space_record::{decode_record, encode_record, record_cid},
    space_set_hash::{RecordPath, SetHashState, set_hash_element},
    space_signature_fields::{members_with_tag, parse_dictionary},
    space_value_budget::ValueBudget,
};

pub(crate) const STAR_CONTENT_TYPE: &str = "application/vnd.dasl.star";
const ARCHIVE_CHUNK_BYTES: usize = 4_096;

/// A revision the host can write, sorted as numbers are.
pub(crate) fn tid(number: u32) -> String {
    const DIGITS: &[u8] = b"234567abcdefghijklmnopqrstuvwxyz";
    let mut text = [b'2'; 13];
    let mut rest = number;
    for slot in text.iter_mut().rev() {
        *slot = DIGITS[(rest % 32) as usize];
        rest /= 32;
    }
    String::from_utf8(text.to_vec()).expect("ascii")
}

pub(crate) fn cid_of(value: &Value) -> Cid {
    record_cid(&encode_record(value).expect("encodable"))
}

#[derive(Clone, Debug)]
pub(crate) struct LoggedOp {
    pub rev: String,
    pub collection: String,
    pub rkey: String,
    pub cid: Option<Cid>,
    pub prev: Option<Cid>,
    pub value: Option<Value>,
}

impl LoggedOp {
    pub fn as_wire(&self) -> Value {
        let mut op = json!({
            "rev": self.rev,
            "collection": self.collection,
            "rkey": self.rkey,
            "cid": self.cid.map(|cid| cid.to_string()),
            "prev": self.prev.map(|cid| cid.to_string()),
        });
        if let (Some(_), Some(value)) = (&self.cid, &self.value) {
            op["value"] = value.clone();
        }
        op
    }
}

/// One member's repo as the host holds it: its records and the log of the ops
/// that made them.
#[derive(Clone)]
pub(crate) struct HostRepo {
    rev: String,
    records: BTreeMap<(String, String), (Cid, Value)>,
    oplog: Vec<LoggedOp>,
}

impl HostRepo {
    pub fn new(rev: u32) -> Self {
        Self {
            rev: tid(rev),
            records: BTreeMap::new(),
            oplog: Vec::new(),
        }
    }

    pub fn put(&mut self, rev: u32, collection: &str, rkey: &str, value: Value) -> &mut Self {
        let key = (collection.to_owned(), rkey.to_owned());
        let cid = cid_of(&value);
        let prev = self.records.get(&key).map(|(held, _)| *held);
        self.oplog.push(LoggedOp {
            rev: tid(rev),
            collection: key.0.clone(),
            rkey: key.1.clone(),
            cid: Some(cid),
            prev,
            value: Some(value.clone()),
        });
        self.records.insert(key, (cid, value));
        self.rev = tid(rev);
        self
    }

    pub fn remove(&mut self, rev: u32, collection: &str, rkey: &str) -> &mut Self {
        let key = (collection.to_owned(), rkey.to_owned());
        let (prev, _) = self.records.remove(&key).expect("a record to remove");
        self.oplog.push(LoggedOp {
            rev: tid(rev),
            collection: key.0,
            rkey: key.1,
            cid: None,
            prev: Some(prev),
            value: None,
        });
        self.rev = tid(rev);
        self
    }

    /// The host forgot its oplog (an import, a clear): a later `since` returns
    /// only the ops written after this, with no error.
    pub fn forget_oplog(&mut self) -> &mut Self {
        self.oplog.clear();
        self
    }

    pub fn rev(&self) -> &str {
        &self.rev
    }

    pub fn digest(&self) -> [u8; 32] {
        let mut state = SetHashState::empty();
        for ((collection, rkey), (cid, _)) in &self.records {
            state.add(&set_hash_element(
                &RecordPath::parse(collection, rkey).expect("a path"),
                cid,
            ));
        }
        state.digest()
    }

    pub fn ops_since(&self, since: Option<&str>) -> Vec<LoggedOp> {
        self.oplog
            .iter()
            .filter(|op| since.is_none_or(|since| op.rev.as_str() > since))
            .cloned()
            .collect()
    }

    pub fn record_bytes(&self) -> Vec<(String, Vec<u8>)> {
        self.records
            .iter()
            .map(|((collection, rkey), (_, value))| {
                (
                    format!("{collection}/{rkey}"),
                    encode_record(value).expect("encodable"),
                )
            })
            .collect()
    }
}

pub(crate) type Hook = Box<dyn FnOnce(&mut HostRepo) + Send>;

/// Lets a test stop the host inside a request and look at the store.
#[derive(Clone)]
pub(crate) struct Gate {
    pub reached: Arc<Notify>,
    pub release: Arc<Notify>,
}

impl Gate {
    pub fn new() -> Self {
        Self {
            reached: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        }
    }

    async fn hold(&self) {
        self.reached.notify_one();
        self.release.notified().await;
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Fault {
    Unreachable,
    Timeout,
    InvalidResponse,
}

impl Fault {
    fn error(self) -> SpaceHostError {
        match self {
            Self::Unreachable => SpaceHostError::Unreachable,
            Self::Timeout => SpaceHostError::Timeout,
            Self::InvalidResponse => SpaceHostError::InvalidResponse,
        }
    }
}

/// What the host does with the next page request of a member; `Honest` when
/// nothing is scripted.
pub(crate) enum PageStep {
    Honest,
    /// An honest page, then `Hook` changes the repo before the next request.
    HonestThen(Hook),
    /// The page and the commit it carries, written as given.
    Written {
        ops: Vec<Value>,
        cursor: Option<String>,
        commit_rev: String,
        commit_data: [u8; 32],
        padding_bytes: usize,
    },
    /// An honest page whose commit is signed over other data.
    WrongDigest([u8; 32]),
    /// A page of no ops whose body carries this JSON text as its `commit`
    /// member; the headers sign the commit the host holds.
    CommitText(String),
    Refused {
        status: u16,
        code: Option<&'static str>,
    },
    Failed(Fault),
    Hang,
    Gate(Gate),
}

pub(crate) enum ArchiveStep {
    Honest,
    WrongDigest([u8; 32]),
    /// An archive written as given; the host signs the commit it holds.
    Raw(Vec<u8>),
    Refused {
        status: u16,
        code: Option<&'static str>,
    },
    Failed(Fault),
    Hang,
    Gate(Gate),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Request {
    Page {
        did: String,
        since: Option<String>,
        cursor: Option<String>,
    },
    Archive {
        did: String,
    },
}

struct Member {
    repo: HostRepo,
    page_steps: VecDeque<PageStep>,
    archive_steps: VecDeque<ArchiveStep>,
}

pub(crate) struct TestHost {
    secret_key: Mutex<SecretKey>,
    space_uri: String,
    members: Mutex<BTreeMap<String, Member>>,
    page_size: AtomicUsize,
    requests: Mutex<Vec<Request>>,
    key_shares: Mutex<Vec<String>>,
    archives_in_flight: Arc<AtomicUsize>,
    most_archives_in_flight: AtomicUsize,
    on_next_request: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

fn host_secret_key() -> SecretKey {
    SecretKey::from_slice(&[0x22; 32]).expect("valid scalar")
}

pub(crate) fn host_kem_key() -> AuthorKemKey {
    AuthorKemKey::from_sec1_bytes(
        host_secret_key()
            .public_key()
            .to_encoded_point(false)
            .as_bytes(),
    )
    .expect("public key")
}

impl TestHost {
    pub fn serving(space_uri: &str) -> Arc<Self> {
        Arc::new(Self {
            secret_key: Mutex::new(host_secret_key()),
            space_uri: space_uri.to_owned(),
            members: Mutex::new(BTreeMap::new()),
            page_size: AtomicUsize::new(1_000),
            requests: Mutex::new(Vec::new()),
            key_shares: Mutex::new(Vec::new()),
            archives_in_flight: Arc::new(AtomicUsize::new(0)),
            most_archives_in_flight: AtomicUsize::new(0),
            on_next_request: Mutex::new(None),
        })
    }

    /// Runs `then` once, when the next request arrives and before it is
    /// answered; a test moves the synchronizer's clock with it.
    pub fn on_next_request(&self, then: impl FnOnce() + Send + 'static) {
        *self.on_next_request.lock().unwrap() = Some(Box::new(then));
    }

    fn note_request(&self, request: Request) {
        self.requests.lock().unwrap().push(request);
        let then = self.on_next_request.lock().unwrap().take();
        if let Some(then) = then {
            then();
        }
    }

    pub fn hold(&self, did: &str, repo: HostRepo) {
        self.members.lock().unwrap().insert(
            did.to_owned(),
            Member {
                repo,
                page_steps: VecDeque::new(),
                archive_steps: VecDeque::new(),
            },
        );
    }

    pub fn edit(&self, did: &str, change: impl FnOnce(&mut HostRepo)) {
        change(&mut self.members.lock().unwrap().get_mut(did).unwrap().repo);
    }

    /// The host starts answering under a key its DID document does not list.
    pub fn answer_under_another_key(&self) {
        *self.secret_key.lock().unwrap() = SecretKey::from_slice(&[0x33; 32]).expect("scalar");
    }

    pub fn set_page_size(&self, size: usize) {
        self.page_size.store(size, Ordering::SeqCst);
    }

    pub fn script_pages(&self, did: &str, steps: Vec<PageStep>) {
        self.members
            .lock()
            .unwrap()
            .get_mut(did)
            .unwrap()
            .page_steps = steps.into();
    }

    pub fn script_archives(&self, did: &str, steps: Vec<ArchiveStep>) {
        self.members
            .lock()
            .unwrap()
            .get_mut(did)
            .unwrap()
            .archive_steps = steps.into();
    }

    /// The key share of each request, in the order sent.
    pub fn key_shares(&self) -> Vec<String> {
        self.key_shares.lock().unwrap().clone()
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }

    pub fn pages_requested(&self, did: &str) -> Vec<(Option<String>, Option<String>)> {
        self.requests()
            .into_iter()
            .filter_map(|request| match request {
                Request::Page {
                    did: asked,
                    since,
                    cursor,
                } if asked == did => Some((since, cursor)),
                _ => None,
            })
            .collect()
    }

    pub fn archives_requested(&self) -> usize {
        self.requests()
            .iter()
            .filter(|request| matches!(request, Request::Archive { .. }))
            .count()
    }

    pub fn most_archives_in_flight(&self) -> usize {
        self.most_archives_in_flight.load(Ordering::SeqCst)
    }

    fn commit_headers(
        &self,
        key_share: &str,
        repo: &str,
        rev: &str,
        data: &[u8; 32],
    ) -> CommitResponseHeaders {
        let secret = decapsulate(&self.secret_key.lock().unwrap(), key_share).expect("a key share");
        let commit_header = format!(
            "ver=1, repo=\"{repo}\", space=\"{}\", rev=\"{rev}\", data=:{}:",
            self.space_uri,
            STANDARD.encode(data)
        );
        let params = format!(
            "(\"atproto-space-commit\";sf);keyid=\"{key_share}\";tag=\"atproto-space-commit\""
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.secret()).unwrap();
        mac.update(
            format!(
                "\"atproto-space-commit\";sf: {commit_header}\n\"@signature-params\": {params}"
            )
            .as_bytes(),
        );
        CommitResponseHeaders {
            commit: vec![commit_header],
            signature_input: vec![format!("mac={params}")],
            signature: vec![format!(
                "mac=:{}:",
                STANDARD.encode(mac.finalize().into_bytes())
            )],
        }
    }

    #[allow(clippy::too_many_arguments)] // The parts of one page a test writes.
    fn page_response(
        &self,
        key_share: &str,
        did: &str,
        ops: Vec<Value>,
        cursor: Option<String>,
        commit_rev: &str,
        commit_data: &[u8; 32],
        padding_bytes: usize,
    ) -> SignedReadResponse {
        SignedReadResponse {
            body: page_body(
                &self.space_uri,
                did,
                &ops,
                cursor.as_deref(),
                commit_rev,
                commit_data,
                padding_bytes,
            ),
            headers: self.commit_headers(key_share, did, commit_rev, commit_data),
        }
    }
}

/// The body of a page: its ops, its cursor, the commit it carries, and
/// `padding_bytes` of filler in a member the reader does not read.
pub(crate) fn page_body(
    space_uri: &str,
    did: &str,
    ops: &[Value],
    cursor: Option<&str>,
    commit_rev: &str,
    commit_data: &[u8; 32],
    padding_bytes: usize,
) -> Vec<u8> {
    let mut body = json!({
        "ops": ops,
        "commit": {
            "ver": 1,
            "repo": did,
            "space": space_uri,
            "rev": commit_rev,
            "data": { "$bytes": STANDARD_NO_PAD.encode(commit_data) },
        },
    });
    if let Some(cursor) = cursor {
        body["cursor"] = json!(cursor);
    }
    if padding_bytes > 0 {
        body["padding"] = json!("x".repeat(padding_bytes));
    }
    serde_json::to_vec(&body).unwrap()
}

pub(crate) fn requested_key_share(accept_signature: &str) -> String {
    let dictionary = parse_dictionary(accept_signature).expect("accept-signature");
    let [member] = members_with_tag(&dictionary, "atproto-space-commit")
        .try_into()
        .ok()
        .expect("one request");
    member
        .members
        .params
        .get("keyid")
        .and_then(|value| value.as_string())
        .expect("keyid")
        .as_str()
        .to_owned()
}

fn refusal(status: u16, code: Option<&'static str>) -> SpaceHostError {
    SpaceHostError::Request {
        status,
        code: code.map(str::to_owned),
    }
}

#[async_trait]
impl RepoOpsTransport for TestHost {
    async fn send(
        &self,
        query: &RepoOpsQuery<'_>,
        accept_signature: &str,
    ) -> Result<SignedReadResponse, SpaceHostError> {
        let key_share = requested_key_share(accept_signature);
        self.key_shares.lock().unwrap().push(key_share.clone());
        self.note_request(Request::Page {
            did: query.actor_did.to_owned(),
            since: query.since.map(str::to_owned),
            cursor: query.cursor.map(str::to_owned),
        });
        let page_size = self.page_size.load(Ordering::SeqCst);
        let served = {
            let mut members = self.members.lock().unwrap();
            let Some(member) = members.get_mut(query.actor_did) else {
                return Err(refusal(400, Some("RepoNotFound")));
            };
            let step = member.page_steps.pop_front().unwrap_or(PageStep::Honest);
            let honest = |member: &Member, data: &[u8; 32]| {
                let start: usize = query
                    .cursor
                    .map(|cursor| cursor.parse().expect("a cursor this host wrote"))
                    .unwrap_or(0);
                let ops = member.repo.ops_since(query.since);
                let page: Vec<Value> = ops
                    .iter()
                    .skip(start)
                    .take(page_size)
                    .map(LoggedOp::as_wire)
                    .collect();
                // A full page always carries a cursor, so the last page may be
                // empty.
                let cursor = (page.len() == page_size).then(|| (start + page_size).to_string());
                self.page_response(
                    &key_share,
                    query.actor_did,
                    page,
                    cursor,
                    member.repo.rev(),
                    data,
                    0,
                )
            };
            match step {
                PageStep::Honest => Served::Now(honest(member, &member.repo.digest())),
                PageStep::HonestThen(hook) => {
                    let response = honest(member, &member.repo.digest());
                    hook(&mut member.repo);
                    Served::Now(response)
                }
                PageStep::WrongDigest(data) => Served::Now(honest(member, &data)),
                PageStep::CommitText(commit) => Served::Now(SignedReadResponse {
                    body: format!("{{\"ops\":[],\"commit\":{commit}}}").into_bytes(),
                    headers: self.commit_headers(
                        &key_share,
                        query.actor_did,
                        member.repo.rev(),
                        &member.repo.digest(),
                    ),
                }),
                PageStep::Written {
                    ops,
                    cursor,
                    commit_rev,
                    commit_data,
                    padding_bytes,
                } => Served::Now(self.page_response(
                    &key_share,
                    query.actor_did,
                    ops,
                    cursor,
                    &commit_rev,
                    &commit_data,
                    padding_bytes,
                )),
                PageStep::Refused { status, code } => return Err(refusal(status, code)),
                PageStep::Failed(fault) => return Err(fault.error()),
                PageStep::Hang => Served::Hang,
                PageStep::Gate(held) => {
                    Served::HeldThen(held, honest(member, &member.repo.digest()))
                }
            }
        };
        served.deliver().await
    }
}

/// What a host does with a request once it has decided its answer: answer,
/// never answer, or answer after a test lets it.
enum Served<T> {
    Now(T),
    Hang,
    HeldThen(Gate, T),
}

impl<T> Served<T> {
    async fn deliver(self) -> Result<T, SpaceHostError> {
        match self {
            Self::Now(response) => Ok(response),
            Self::Hang => std::future::pending().await,
            Self::HeldThen(gate, response) => {
                gate.hold().await;
                Ok(response)
            }
        }
    }
}

struct ScriptedBody {
    chunks: VecDeque<Vec<u8>>,
    _in_flight: InFlight,
}

struct InFlight(Arc<AtomicUsize>);

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl ArchiveBody for ScriptedBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, SpaceHostError> {
        Ok(self.chunks.pop_front())
    }
}

/// The archive a host writes: the commit as metadata, then each record in
/// path order, then the end marker.
pub(crate) fn star_archive(
    did: &str,
    space_uri: &str,
    rev: &str,
    data: &[u8; 32],
    mut pairs: Vec<(String, Vec<u8>)>,
) -> Vec<u8> {
    fn varint(mut value: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        while value >= 0x80 {
            bytes.push((value % 0x80) as u8 | 0x80);
            value /= 0x80;
        }
        bytes.push(value as u8);
        bytes
    }
    fn framed(bytes: &[u8]) -> Vec<u8> {
        let mut out = varint(bytes.len());
        out.extend_from_slice(bytes);
        out
    }
    let metadata = encode_record(&json!({
        "$type": REPO_ARCHIVE_TYPE,
        "ver": 1,
        "repo": did,
        "space": space_uri,
        "rev": rev,
        "data": { "$bytes": STANDARD_NO_PAD.encode(data) },
    }))
    .expect("encodes");
    pairs.sort();
    let mut archive = vec![0x2a, 0x6c, 0x01, 0x00];
    archive.extend(framed(&metadata));
    for (path, bytes) in pairs {
        archive.push(0x01);
        archive.extend(framed(path.as_bytes()));
        archive.extend(framed(&bytes));
    }
    archive.push(0x00);
    archive
}

#[async_trait]
impl RepoArchiveTransport for TestHost {
    async fn send_archive(
        &self,
        query: &RepoArchiveQuery<'_>,
        accept_signature: &str,
    ) -> Result<SignedArchiveResponse, SpaceHostError> {
        let key_share = requested_key_share(accept_signature);
        self.key_shares.lock().unwrap().push(key_share.clone());
        self.note_request(Request::Archive {
            did: query.actor_did.to_owned(),
        });
        let in_flight = self.archives_in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_archives_in_flight
            .fetch_max(in_flight, Ordering::SeqCst);
        let guard = InFlight(Arc::clone(&self.archives_in_flight));
        let served = {
            let mut members = self.members.lock().unwrap();
            let Some(member) = members.get_mut(query.actor_did) else {
                return Err(refusal(400, Some("RepoNotFound")));
            };
            let step = member
                .archive_steps
                .pop_front()
                .unwrap_or(ArchiveStep::Honest);
            let own = |member: &Member, data: [u8; 32]| {
                (
                    member.repo.rev().to_owned(),
                    data,
                    star_archive(
                        query.actor_did,
                        &self.space_uri,
                        member.repo.rev(),
                        &data,
                        member.repo.record_bytes(),
                    ),
                )
            };
            match step {
                ArchiveStep::Honest => Served::Now(own(member, member.repo.digest())),
                ArchiveStep::WrongDigest(data) => Served::Now(own(member, data)),
                ArchiveStep::Raw(bytes) => {
                    Served::Now((member.repo.rev().to_owned(), member.repo.digest(), bytes))
                }
                ArchiveStep::Refused { status, code } => return Err(refusal(status, code)),
                ArchiveStep::Failed(fault) => return Err(fault.error()),
                ArchiveStep::Hang => Served::Hang,
                ArchiveStep::Gate(held) => {
                    Served::HeldThen(held, own(member, member.repo.digest()))
                }
            }
        };
        let (rev, data, bytes) = served.deliver().await?;
        let headers = self.commit_headers(&key_share, query.actor_did, &rev, &data);
        let chunks = bytes
            .chunks(ARCHIVE_CHUNK_BYTES)
            .map(<[u8]>::to_vec)
            .collect();
        Ok(SignedArchiveResponse {
            content_type: Some(STAR_CONTENT_TYPE.to_owned()),
            headers,
            body: Box::new(ScriptedBody {
                chunks,
                _in_flight: guard,
            }),
        })
    }
}

/// The author's KEM key, as a resolver whose answer a test can withdraw.
pub(crate) struct StaticKemKeys {
    key: AuthorKemKey,
    unavailable: AtomicBool,
}

impl StaticKemKeys {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            key: host_kem_key(),
            unavailable: AtomicBool::new(false),
        })
    }

    pub fn withdraw(&self) {
        self.unavailable.store(true, Ordering::SeqCst);
    }

    pub fn restore(&self) {
        self.unavailable.store(false, Ordering::SeqCst);
    }

    fn answer(&self) -> Result<AuthorKemKey, KemKeyLookupError> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(KemKeyLookupError::Unavailable);
        }
        Ok(self.key.clone())
    }
}

#[async_trait]
impl AuthorKemKeyResolver for StaticKemKeys {
    async fn author_kem_key(&self, _: &str) -> Result<AuthorKemKey, KemKeyLookupError> {
        self.answer()
    }

    async fn refreshed_author_kem_key(&self, _: &str) -> Result<AuthorKemKey, KemKeyLookupError> {
        self.answer()
    }
}

/// The reader the synchronizer is given: the production authenticated reads
/// over the in-process host.
pub(crate) struct TestReader {
    host: Arc<TestHost>,
    kem_keys: Arc<StaticKemKeys>,
}

#[async_trait]
impl VerifiedSpaceReader for TestReader {
    async fn read_page(
        &self,
        target: &PdsPollTarget,
        request: PageRequest<'_>,
        deadline: Instant,
    ) -> Result<AuthenticatedPage, AuthenticatedReadError> {
        authenticated_read(
            self.host.as_ref(),
            self.kem_keys.as_ref(),
            &RepoOpsQuery {
                space_uri: &target.space_uri,
                actor_did: &target.did,
                since: request.since,
                cursor: request.cursor,
                limit: request.limit,
            },
            deadline,
        )
        .await
    }

    async fn read_archive(
        &self,
        target: &PdsPollTarget,
        deadline: Instant,
        budget: &ValueBudget,
    ) -> Result<AuthenticatedArchive, AuthenticatedReadError> {
        authenticated_archive_read(
            self.host.as_ref(),
            self.kem_keys.as_ref(),
            &RepoArchiveQuery {
                space_uri: &target.space_uri,
                actor_did: &target.did,
            },
            deadline,
            &decode_record,
            budget,
        )
        .await
    }
}

/// Hosts by the address the authority names for a member.
pub(crate) struct TestSource {
    hosts: Mutex<BTreeMap<String, Arc<TestHost>>>,
    kem_keys: Arc<StaticKemKeys>,
}

impl TestSource {
    pub fn new(kem_keys: Arc<StaticKemKeys>) -> Arc<Self> {
        Arc::new(Self {
            hosts: Mutex::new(BTreeMap::new()),
            kem_keys,
        })
    }

    pub fn host_at(&self, address: &str, host: Arc<TestHost>) {
        self.hosts.lock().unwrap().insert(address.to_owned(), host);
    }
}

#[async_trait]
impl VerifiedSpaceReaderSource for TestSource {
    async fn connect(
        &self,
        target: &PdsPollTarget,
        _: Arc<HeldSpaceCredential>,
    ) -> Result<Arc<dyn VerifiedSpaceReader>, SpaceHostError> {
        let host = self
            .hosts
            .lock()
            .unwrap()
            .get(&target.host)
            .cloned()
            .ok_or(SpaceHostError::Unreachable)?;
        Ok(Arc::new(TestReader {
            host,
            kem_keys: Arc::clone(&self.kem_keys),
        }))
    }
}

/// A clock a test moves by hand. The instants are real ones offset by what
/// the test has advanced, so a deadline computed from it still means something
/// to the timers.
pub(crate) struct TestClock {
    base: Instant,
    advanced: Mutex<Duration>,
}

impl TestClock {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            base: Instant::now(),
            advanced: Mutex::new(Duration::ZERO),
        })
    }

    pub fn advance(&self, by: Duration) {
        *self.advanced.lock().unwrap() += by;
    }
}

impl super::SyncClock for TestClock {
    fn now(&self) -> Instant {
        self.base + *self.advanced.lock().unwrap()
    }

    fn utc_millis(&self) -> String {
        "2026-09-22T00:00:00.000Z".to_owned()
    }
}

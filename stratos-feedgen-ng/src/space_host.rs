use std::{env, future::Future, net::SocketAddr, sync::Arc, time::Duration};

use async_trait::async_trait;
use cid::Cid;
use reqwest::{Client, redirect::Policy};
use serde::{
    Deserialize,
    de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Number, Value};
use tokio::time::Instant;
use url::Url;

use crate::{
    config::MAX_SPACE_POLL_BODY_BYTES,
    identifier::Did,
    identity::{PrivateCidr, is_public_address, parse_private_cidrs},
    space_archive::{
        ArchiveItem, ArchiveReader, ArchiveRefusal, RecordOrderRefusal, check_record_order,
        commit_from_metadata,
    },
    space_http_signature::SpaceHttpSignatureHeaders,
    space_identity::{AuthorKemKeyResolver, KemKeyLookupError},
    space_kem::{AuthorKemKey, encapsulate},
    space_mac::{
        CommitResponseHeaders, MacRequestContext, MacVerifiedCommit, MacVerifyError,
        verify_commit_response,
    },
    space_record::{RecordDecodeRefusal, decode_record},
    space_sync::{MAX_SPACE_PAGE_OPS, is_projected_collection},
    space_value_budget::{ValueBudget, count_values},
    store::VerifiedSpaceRecord,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ERROR_BYTES: usize = 4 * 1024;
const MAX_CURSOR_BYTES: usize = 4 * 1024;
const MAX_REV_BYTES: usize = 512;
const STAR_CONTENT_TYPE: &str = "application/vnd.dasl.star";
// The client-wide timeout covers the whole body and is sized for a page. An
// archive can be sixteen times larger; the caller's absolute deadline is what
// bounds the read, so this only has to be no shorter than that deadline.
const ARCHIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Eq, PartialEq)]
pub enum SpaceHostError {
    InvalidOrigin,
    InvalidPrivateAddressPolicy,
    InvalidRequest,
    UnsafeAddress,
    Unreachable,
    Redirect,
    Timeout,
    ResponseTooLarge,
    InvalidResponse,
    Request { status: u16, code: Option<String> },
    Proof,
}

impl std::fmt::Display for SpaceHostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidOrigin => formatter.write_str("space host origin is invalid"),
            Self::InvalidPrivateAddressPolicy => {
                formatter.write_str("space host private address policy is invalid")
            }
            Self::InvalidRequest => formatter.write_str("space host request is invalid"),
            Self::UnsafeAddress => formatter.write_str("space host resolved an unsafe address"),
            Self::Unreachable => formatter.write_str("space host is unreachable"),
            Self::Redirect => formatter.write_str("space host attempted a redirect"),
            Self::Timeout => formatter.write_str("space host request timed out"),
            Self::ResponseTooLarge => formatter.write_str("space host response exceeded its limit"),
            Self::InvalidResponse => formatter.write_str("space host response is invalid"),
            Self::Request { status, .. } => write!(formatter, "space host returned HTTP {status}"),
            Self::Proof => formatter.write_str("space credential presentation failed"),
        }
    }
}

impl std::error::Error for SpaceHostError {}

#[async_trait]
pub trait HostResolver: Send + Sync {
    async fn resolve(&self, hostname: &str, port: u16) -> Result<Vec<SocketAddr>, SpaceHostError>;
}

pub struct SystemHostResolver;

#[async_trait]
impl HostResolver for SystemHostResolver {
    async fn resolve(&self, hostname: &str, port: u16) -> Result<Vec<SocketAddr>, SpaceHostError> {
        tokio::net::lookup_host((hostname, port))
            .await
            .map(|addresses| addresses.collect())
            .map_err(|_| SpaceHostError::Unreachable)
    }
}

#[async_trait]
pub trait SpaceCredentialProof: Send + Sync {
    async fn presentation_headers(
        &self,
        audience: &Did,
    ) -> Result<SpaceHttpSignatureHeaders, SpaceHostError>;
}

pub struct PinnedSpaceHostClient {
    origin: Url,
    client: Client,
    proof: Arc<dyn SpaceCredentialProof>,
}

impl PinnedSpaceHostClient {
    pub async fn connect(
        origin: &str,
        proof: Arc<dyn SpaceCredentialProof>,
    ) -> Result<Self, SpaceHostError> {
        let private_policy = PrivateHostPolicy::from_env()?;
        Self::connect_with_resolver_and_policy(
            origin,
            proof,
            &SystemHostResolver,
            private_policy.as_ref(),
        )
        .await
    }

    pub async fn connect_with_resolver(
        origin: &str,
        proof: Arc<dyn SpaceCredentialProof>,
        resolver: &dyn HostResolver,
    ) -> Result<Self, SpaceHostError> {
        Self::connect_with_resolver_and_policy(origin, proof, resolver, None).await
    }

    async fn connect_with_resolver_and_policy(
        origin: &str,
        proof: Arc<dyn SpaceCredentialProof>,
        resolver: &dyn HostResolver,
        private_policy: Option<&PrivateHostPolicy>,
    ) -> Result<Self, SpaceHostError> {
        let origin = parse_origin(origin)?;
        let host = origin.host_str().ok_or(SpaceHostError::InvalidOrigin)?;
        let port = origin
            .port_or_known_default()
            .ok_or(SpaceHostError::InvalidOrigin)?;
        let addresses = resolver.resolve(host, port).await?;
        let address = validate_addresses(&origin, &addresses, private_policy)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .https_only(true)
            .connect_timeout(REQUEST_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .resolve(host, address)
            .build()
            .map_err(|_| SpaceHostError::Unreachable)?;
        Ok(Self {
            origin,
            client,
            proof,
        })
    }

    // One page of an authenticated read: `since` rides beside the cursor, and
    // the MAC is asked for in the request itself.
    async fn ops_request(
        &self,
        query: &RepoOpsQuery<'_>,
        accept_signature: &str,
    ) -> Result<reqwest::RequestBuilder, SpaceHostError> {
        validate_request(query.space_uri, query.actor_did, query.cursor, query.limit)?;
        if query
            .since
            .is_some_and(|since| since.is_empty() || since.len() > MAX_REV_BYTES)
        {
            return Err(SpaceHostError::InvalidRequest);
        }
        let limit = query.limit.to_string();
        let mut parameters = vec![
            ("space", query.space_uri),
            ("repo", query.actor_did),
            ("limit", limit.as_str()),
        ];
        if let Some(since) = query.since {
            parameters.push(("since", since));
        }
        if let Some(cursor) = query.cursor {
            parameters.push(("cursor", cursor));
        }
        Ok(self
            .signed_request(
                "com.atproto.space.listRepoOps",
                &parameters,
                query.actor_did,
                "application/json",
            )
            .await?
            .header("accept-signature", accept_signature))
    }

    async fn archive_request(
        &self,
        query: &RepoArchiveQuery<'_>,
        accept_signature: &str,
    ) -> Result<reqwest::RequestBuilder, SpaceHostError> {
        validate_identifiers(query.space_uri, query.actor_did)?;
        Ok(self
            .signed_request(
                "com.atproto.space.getRepo",
                &[("space", query.space_uri), ("repo", query.actor_did)],
                query.actor_did,
                STAR_CONTENT_TYPE,
            )
            .await?
            .header("accept-signature", accept_signature)
            .timeout(ARCHIVE_REQUEST_TIMEOUT))
    }

    // The credential presentation is bound to the repo's owner, not to the host.
    async fn signed_request(
        &self,
        lxm: &str,
        parameters: &[(&str, &str)],
        actor_did: &str,
        accept: &str,
    ) -> Result<reqwest::RequestBuilder, SpaceHostError> {
        let mut url = self.endpoint_url(lxm)?;
        url.query_pairs_mut().extend_pairs(parameters);
        let audience = Did::parse(actor_did).map_err(|_| SpaceHostError::InvalidRequest)?;
        let headers = self.proof.presentation_headers(&audience).await?;
        Ok(self
            .client
            .get(url)
            .header("accept", accept)
            .header("authorization", headers.authorization())
            .header("atproto-space-audience", audience.as_str())
            .header("signature-input", headers.signature_input())
            .header("signature", headers.signature()))
    }

    fn endpoint_url(&self, lxm: &str) -> Result<Url, SpaceHostError> {
        self.origin
            .join(&format!("xrpc/{lxm}"))
            .map_err(|_| SpaceHostError::InvalidOrigin)
    }
}

impl PinnedSpaceHostClient {
    /// `listRepoOps` with the response authenticated: the body is returned only
    /// with the commit its MAC covers. `since` is the revision of the base the
    /// caller already holds (absent when it holds none) and rides on every page
    /// beside that page's cursor. A stale KEM key is refreshed once and the
    /// whole request is sent again with a new key share; every wait is bounded
    /// by `deadline`.
    #[allow(clippy::too_many_arguments)] // One page request names each of its parts.
    pub async fn list_repo_ops_authenticated(
        &self,
        kem_keys: &dyn AuthorKemKeyResolver,
        space_uri: &str,
        actor_did: &str,
        since: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        deadline: Instant,
    ) -> Result<AuthenticatedPage, AuthenticatedReadError> {
        let query = RepoOpsQuery {
            space_uri,
            actor_did,
            since,
            cursor,
            limit,
        };
        authenticated_read(self, kem_keys, &query, deadline).await
    }

    /// `getRepo` with the response authenticated: the member's whole repo in the
    /// space, returned only when the archive ended cleanly, its metadata commit
    /// carries the response's MAC, and every record decoded and followed the
    /// one before it in path order. The retry and deadline rules are those of
    /// the page read. The records are not yet checked against the commit's
    /// `data`: the store does that. A record in a collection the projection
    /// does not read is held to its CID and returned without its value; the
    /// values of the others are charged to `budget` as each is decoded, and an
    /// archive that would pass it is refused whole.
    pub async fn read_repo_archive_authenticated(
        &self,
        kem_keys: &dyn AuthorKemKeyResolver,
        space_uri: &str,
        actor_did: &str,
        deadline: Instant,
        budget: &ValueBudget,
    ) -> Result<AuthenticatedArchive, AuthenticatedReadError> {
        let query = RepoArchiveQuery {
            space_uri,
            actor_did,
        };
        authenticated_archive_read(self, kem_keys, &query, deadline, &decode_record, budget).await
    }
}

/// A page body together with the commit that was verified for it. There is no
/// way to take the bytes without the commit.
pub struct AuthenticatedPage {
    body: Vec<u8>,
    commit: MacVerifiedCommit,
}

impl AuthenticatedPage {
    pub fn body(&self) -> &[u8] {
        &self.body
    }

    pub fn commit(&self) -> &MacVerifiedCommit {
        &self.commit
    }
}

/// A member's whole repo in a space with the commit that was verified for it.
/// There is no way to take the records without the commit, and none to make one
/// from an archive that was not read to its end marker with the MAC verified.
pub struct AuthenticatedArchive {
    commit: MacVerifiedCommit,
    records: Vec<VerifiedSpaceRecord>,
}

impl AuthenticatedArchive {
    pub fn commit(&self) -> &MacVerifiedCommit {
        &self.commit
    }

    pub fn records(&self) -> &[VerifiedSpaceRecord] {
        &self.records
    }

    pub fn into_parts(self) -> (MacVerifiedCommit, Vec<VerifiedSpaceRecord>) {
        (self.commit, self.records)
    }
}

/// `KemKeyUnavailable` defers the target; every other variant fails it.
/// `Archive`, `ArchiveRecord` and `ArchiveOrder` carry fixed reasons only.
#[derive(Debug, Eq, PartialEq)]
pub enum AuthenticatedReadError {
    KemKeyUnavailable,
    KemKeyInvalid,
    Host(SpaceHostError),
    Authentication(MacVerifyError),
    Archive(ArchiveRefusal),
    ArchiveRecord(RecordDecodeRefusal),
    ArchiveOrder(RecordOrderRefusal),
    OverBudget,
    DeadlineExceeded,
}

impl AuthenticatedReadError {
    pub fn is_deferred(&self) -> bool {
        matches!(self, Self::KemKeyUnavailable)
    }
}

impl std::fmt::Display for AuthenticatedReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::KemKeyUnavailable => formatter.write_str("author key service is unavailable"),
            Self::KemKeyInvalid => formatter.write_str("author has no usable KEM key"),
            Self::Host(error) => error.fmt(formatter),
            Self::Authentication(error) => error.fmt(formatter),
            Self::Archive(error) => error.fmt(formatter),
            Self::ArchiveRecord(error) => error.fmt(formatter),
            Self::ArchiveOrder(error) => error.fmt(formatter),
            Self::OverBudget => {
                formatter.write_str("archive holds more decoded values than allowed")
            }
            Self::DeadlineExceeded => formatter.write_str("authenticated read ran out of time"),
        }
    }
}

impl std::error::Error for AuthenticatedReadError {}

/// One page request, as it is sent and as the response's commit is bound to it.
pub(crate) struct RepoOpsQuery<'a> {
    pub(crate) space_uri: &'a str,
    pub(crate) actor_did: &'a str,
    pub(crate) since: Option<&'a str>,
    pub(crate) cursor: Option<&'a str>,
    pub(crate) limit: usize,
}

/// One archive request.
pub(crate) struct RepoArchiveQuery<'a> {
    pub(crate) space_uri: &'a str,
    pub(crate) actor_did: &'a str,
}

/// A success response: its body and the raw lines of the three headers that
/// authenticate it. Nothing outside this module reads the body from it.
#[derive(Clone)]
pub(crate) struct SignedReadResponse {
    pub(crate) body: Vec<u8>,
    pub(crate) headers: CommitResponseHeaders,
}

/// A success response to an archive request. The body is not collected: it is
/// read chunk by chunk, so the archive is never held whole beside its records.
pub(crate) struct SignedArchiveResponse {
    pub(crate) content_type: Option<String>,
    pub(crate) headers: CommitResponseHeaders,
    pub(crate) body: Box<dyn ArchiveBody>,
}

/// The chunks of an archive body, until `None`.
#[async_trait]
pub(crate) trait ArchiveBody: Send {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, SpaceHostError>;
}

#[async_trait]
impl ArchiveBody for reqwest::Response {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, SpaceHostError> {
        self.chunk()
            .await
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
            .map_err(classify_request_error)
    }
}

/// Sending one request and collecting a success response. The pinned client
/// implements it with the client it already builds; a non-success status is
/// the existing request error.
#[async_trait]
pub(crate) trait RepoOpsTransport: Send + Sync {
    async fn send(
        &self,
        query: &RepoOpsQuery<'_>,
        accept_signature: &str,
    ) -> Result<SignedReadResponse, SpaceHostError>;
}

/// Sending one archive request and handing back the response before its body
/// is read.
#[async_trait]
pub(crate) trait RepoArchiveTransport: Send + Sync {
    async fn send_archive(
        &self,
        query: &RepoArchiveQuery<'_>,
        accept_signature: &str,
    ) -> Result<SignedArchiveResponse, SpaceHostError>;
}

#[async_trait]
impl RepoOpsTransport for PinnedSpaceHostClient {
    async fn send(
        &self,
        query: &RepoOpsQuery<'_>,
        accept_signature: &str,
    ) -> Result<SignedReadResponse, SpaceHostError> {
        let response = self
            .ops_request(query, accept_signature)
            .await?
            .send()
            .await
            .map_err(classify_request_error)?;
        if !response.status().is_success() {
            return Err(request_error(response).await);
        }
        let headers = commit_response_headers(&response);
        let body = read_page_body(response).await?;
        Ok(SignedReadResponse { body, headers })
    }
}

// A poll reads no more than its body limit in all, so no one page may be more.
async fn read_page_body(response: reqwest::Response) -> Result<Vec<u8>, SpaceHostError> {
    response_bytes(response, MAX_SPACE_POLL_BODY_BYTES).await
}

#[async_trait]
impl RepoArchiveTransport for PinnedSpaceHostClient {
    async fn send_archive(
        &self,
        query: &RepoArchiveQuery<'_>,
        accept_signature: &str,
    ) -> Result<SignedArchiveResponse, SpaceHostError> {
        let response = self
            .archive_request(query, accept_signature)
            .await?
            .send()
            .await
            .map_err(classify_request_error)?;
        if !response.status().is_success() {
            return Err(request_error(response).await);
        }
        Ok(SignedArchiveResponse {
            content_type: header_lines(&response, "content-type").into_iter().next(),
            headers: commit_response_headers(&response),
            body: Box::new(response),
        })
    }
}

fn commit_response_headers(response: &reqwest::Response) -> CommitResponseHeaders {
    CommitResponseHeaders {
        commit: header_lines(response, "atproto-space-commit"),
        signature_input: header_lines(response, "signature-input"),
        signature: header_lines(response, "signature"),
    }
}

// `get_all` yields each header line the host sent; `get` would hide a repeat.
fn header_lines(response: &reqwest::Response, name: &str) -> Vec<String> {
    response
        .headers()
        .get_all(name)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .collect()
}

pub(crate) async fn authenticated_read(
    transport: &dyn RepoOpsTransport,
    kem_keys: &dyn AuthorKemKeyResolver,
    query: &RepoOpsQuery<'_>,
    deadline: Instant,
) -> Result<AuthenticatedPage, AuthenticatedReadError> {
    read_with_key_refresh(kem_keys, query.actor_did, deadline, |kem_key| {
        attempt(transport, kem_key, query, deadline)
    })
    .await
}

pub(crate) type RecordDecoder<'a> =
    dyn Fn(&[u8]) -> Result<(Cid, Value), RecordDecodeRefusal> + Sync + 'a;

pub(crate) async fn authenticated_archive_read(
    transport: &dyn RepoArchiveTransport,
    kem_keys: &dyn AuthorKemKeyResolver,
    query: &RepoArchiveQuery<'_>,
    deadline: Instant,
    decode: &RecordDecoder<'_>,
    budget: &ValueBudget,
) -> Result<AuthenticatedArchive, AuthenticatedReadError> {
    read_with_key_refresh(kem_keys, query.actor_did, deadline, |kem_key| {
        archive_attempt(transport, kem_key, query, deadline, decode, budget)
    })
    .await
}

// The retry rule both reads share: only a MAC mismatch is taken for a stale
// key, the key is refreshed once, and an unchanged key fails without a second
// request. `attempt` makes its own ephemeral key and context each time.
async fn read_with_key_refresh<T, Attempt, Pending>(
    kem_keys: &dyn AuthorKemKeyResolver,
    actor_did: &str,
    deadline: Instant,
    attempt: Attempt,
) -> Result<T, AuthenticatedReadError>
where
    Attempt: Fn(AuthorKemKey) -> Pending,
    Pending: Future<Output = Result<T, AuthenticatedReadError>>,
{
    let first_key = before(deadline, kem_keys.author_kem_key(actor_did))
        .await?
        .map_err(kem_lookup_failure)?;
    match attempt(first_key.clone()).await {
        Err(AuthenticatedReadError::Authentication(MacVerifyError::MacMismatch)) => {}
        outcome => return outcome,
    }
    let refreshed_key = before(deadline, kem_keys.refreshed_author_kem_key(actor_did))
        .await?
        .map_err(kem_lookup_failure)?;
    if refreshed_key == first_key {
        return Err(AuthenticatedReadError::Authentication(
            MacVerifyError::MacMismatch,
        ));
    }
    attempt(refreshed_key).await
}

// Each attempt makes its own ephemeral key and consumes its own context.
async fn attempt(
    transport: &dyn RepoOpsTransport,
    kem_key: AuthorKemKey,
    query: &RepoOpsQuery<'_>,
    deadline: Instant,
) -> Result<AuthenticatedPage, AuthenticatedReadError> {
    let secret = encapsulate(&kem_key).map_err(|_| AuthenticatedReadError::KemKeyInvalid)?;
    let context = MacRequestContext::new(secret, query.actor_did, query.space_uri);
    let accept_signature = context.accept_signature();
    let response = before(deadline, transport.send(query, &accept_signature))
        .await?
        .map_err(AuthenticatedReadError::Host)?;
    let commit = body_commit(&response.body)?;
    let verified = verify_commit_response(context, &response.headers, &commit)
        .map_err(AuthenticatedReadError::Authentication)?;
    Ok(AuthenticatedPage {
        body: response.body,
        commit: verified,
    })
}

// The MAC is checked on the metadata, the first thing the archive holds, before
// a record is looked at; what follows is collected locally and handed out only
// when the archive has ended cleanly.
async fn archive_attempt(
    transport: &dyn RepoArchiveTransport,
    kem_key: AuthorKemKey,
    query: &RepoArchiveQuery<'_>,
    deadline: Instant,
    decode: &RecordDecoder<'_>,
    budget: &ValueBudget,
) -> Result<AuthenticatedArchive, AuthenticatedReadError> {
    let secret = encapsulate(&kem_key).map_err(|_| AuthenticatedReadError::KemKeyInvalid)?;
    let context = MacRequestContext::new(secret, query.actor_did, query.space_uri);
    let accept_signature = context.accept_signature();
    let mut response = before(deadline, transport.send_archive(query, &accept_signature))
        .await?
        .map_err(AuthenticatedReadError::Host)?;
    if !is_star_content_type(response.content_type.as_deref()) {
        return Err(AuthenticatedReadError::Host(
            SpaceHostError::InvalidResponse,
        ));
    }
    let mut reader = ArchiveReader::new();
    let mut collector = ArchiveCollector {
        unverified: Some((context, response.headers)),
        verified: None,
    };
    while let Some(chunk) = before(deadline, response.body.next_chunk())
        .await?
        .map_err(AuthenticatedReadError::Host)?
    {
        reader
            .push(&chunk)
            .map_err(AuthenticatedReadError::Archive)?;
        while let Some(item) = reader
            .next_item()
            .map_err(AuthenticatedReadError::Archive)?
        {
            collector.accept(item, decode, budget)?;
        }
    }
    reader.finish().map_err(AuthenticatedReadError::Archive)?;
    collector.finished()
}

struct VerifiedPrefix {
    commit: MacVerifiedCommit,
    records: Vec<VerifiedSpaceRecord>,
    previous_path: Option<Vec<u8>>,
}

struct ArchiveCollector {
    unverified: Option<(MacRequestContext, CommitResponseHeaders)>,
    verified: Option<VerifiedPrefix>,
}

impl ArchiveCollector {
    fn accept(
        &mut self,
        item: ArchiveItem,
        decode: &RecordDecoder<'_>,
        budget: &ValueBudget,
    ) -> Result<(), AuthenticatedReadError> {
        match item {
            ArchiveItem::Metadata(metadata) => {
                let (context, headers) = self
                    .unverified
                    .take()
                    .ok_or(AuthenticatedReadError::Archive(ArchiveRefusal::BadMetadata))?;
                let commit =
                    commit_from_metadata(metadata).map_err(AuthenticatedReadError::Archive)?;
                let commit = verify_commit_response(context, &headers, &commit)
                    .map_err(AuthenticatedReadError::Authentication)?;
                self.verified = Some(VerifiedPrefix {
                    commit,
                    records: Vec::new(),
                    previous_path: None,
                });
            }
            ArchiveItem::Record { path, value } => {
                let prefix = self
                    .verified
                    .as_mut()
                    .ok_or(AuthenticatedReadError::Archive(ArchiveRefusal::BadMetadata))?;
                let path_of_record = check_record_order(prefix.previous_path.as_deref(), &path)
                    .map_err(AuthenticatedReadError::ArchiveOrder)?;
                let (cid, value) = decode(&value).map_err(AuthenticatedReadError::ArchiveRecord)?;
                // The record was held to its bytes by the decoder; the digest
                // covers its CID, so a value nothing will project is dropped
                // here, uncounted, instead of being held until the store sees it.
                let value = if is_projected_collection(path_of_record.collection()) {
                    budget
                        .charge(count_values(&value))
                        .map_err(|_| AuthenticatedReadError::OverBudget)?;
                    Some(value)
                } else {
                    None
                };
                prefix.records.push(VerifiedSpaceRecord {
                    path: path_of_record,
                    cid,
                    value,
                });
                prefix.previous_path = Some(path);
            }
        }
        Ok(())
    }

    fn finished(self) -> Result<AuthenticatedArchive, AuthenticatedReadError> {
        let prefix = self.verified.ok_or(AuthenticatedReadError::Archive(
            ArchiveRefusal::UnexpectedEnd,
        ))?;
        Ok(AuthenticatedArchive {
            commit: prefix.commit,
            records: prefix.records,
        })
    }
}

fn is_star_content_type(content_type: Option<&str>) -> bool {
    content_type
        .and_then(|value| value.split(';').next())
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case(STAR_CONTENT_TYPE))
}

async fn before<T>(
    deadline: Instant,
    wait: impl Future<Output = T>,
) -> Result<T, AuthenticatedReadError> {
    if Instant::now() >= deadline {
        return Err(AuthenticatedReadError::DeadlineExceeded);
    }
    tokio::time::timeout_at(deadline, wait)
        .await
        .map_err(|_| AuthenticatedReadError::DeadlineExceeded)
}

fn kem_lookup_failure(error: KemKeyLookupError) -> AuthenticatedReadError {
    match error {
        KemKeyLookupError::Unavailable => AuthenticatedReadError::KemKeyUnavailable,
        KemKeyLookupError::Invalid => AuthenticatedReadError::KemKeyInvalid,
    }
}

// The host shapes the `commit` member, and it is read before the MAC is checked
// or a value is counted, so it is never built whole.
fn body_commit(body: &[u8]) -> Result<Value, AuthenticatedReadError> {
    #[derive(Deserialize)]
    struct CommitMember {
        commit: Option<BoundedCommit>,
    }
    serde_json::from_slice::<CommitMember>(body)
        .ok()
        .and_then(|member| member.commit)
        .map(|commit| commit.0)
        .ok_or(AuthenticatedReadError::Host(
            SpaceHostError::InvalidResponse,
        ))
}

const COMMIT_SCALAR_MEMBERS: [&str; 4] = ["ver", "repo", "space", "rev"];
const COMMIT_DATA_MEMBER: &str = "data";
const BYTES_MEMBER: &str = "$bytes";

/// A page's `commit` member holding only what the MAC verifier compares:
/// `ver`, `repo`, `space` and `rev` when each is a scalar, and `data` when it
/// is a map of `$bytes` alone. Anything else is parsed to its end and dropped
/// unbuilt, or kept as `null` where the verifier would refuse what was there,
/// so the verifier reaches the verdict the whole tree gave it.
struct BoundedCommit(Value);

impl<'de> Deserialize<'de> for BoundedCommit {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        CommitPart::Commit.deserialize(deserializer).map(Self)
    }
}

/// What a part of the commit member is read as. Every part is parsed the way a
/// tree would be, so a body refused before is refused still; a later member of
/// a name replaces an earlier one, as in a tree.
#[derive(Clone, Copy)]
enum CommitPart {
    Commit,
    Data,
    Scalar,
    Dropped,
}

impl<'de> DeserializeSeed<'de> for CommitPart {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl CommitPart {
    fn scalar_or_null(self, value: Value) -> Value {
        match self {
            Self::Scalar => value,
            _ => Value::Null,
        }
    }
}

impl<'de> Visitor<'de> for CommitPart {
    type Value = Value;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(self.scalar_or_null(Value::Bool(value)))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(self.scalar_or_null(Value::from(value)))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(self.scalar_or_null(Value::from(value)))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        Ok(self.scalar_or_null(Number::from_f64(value).map_or(Value::Null, Value::Number)))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        match self {
            Self::Scalar => Ok(Value::String(value.to_owned())),
            _ => Ok(Value::Null),
        }
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<Value, A::Error> {
        while items.next_element_seed(Self::Dropped)?.is_some() {}
        Ok(Value::Null)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut members: A) -> Result<Value, A::Error> {
        let mut kept = Map::new();
        let mut foreign_member = false;
        while let Some(name) = members.next_key_seed(MemberName)? {
            let part = match (self, name.as_deref()) {
                (Self::Commit, Some(name)) if COMMIT_SCALAR_MEMBERS.contains(&name) => Self::Scalar,
                (Self::Commit, Some(COMMIT_DATA_MEMBER)) => Self::Data,
                (Self::Data, Some(BYTES_MEMBER)) => Self::Scalar,
                _ => {
                    foreign_member = true;
                    Self::Dropped
                }
            };
            let value = members.next_value_seed(part)?;
            if !matches!(part, Self::Dropped)
                && let Some(name) = name
            {
                kept.insert(name, value);
            }
        }
        Ok(match self {
            Self::Commit => Value::Object(kept),
            // The verifier takes `data` only when `$bytes` is its one member.
            Self::Data if !foreign_member => Value::Object(kept),
            _ => Value::Null,
        })
    }
}

/// A member name, kept only when it is one the commit reads.
struct MemberName;

impl<'de> DeserializeSeed<'de> for MemberName {
    type Value = Option<String>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for MemberName {
    type Value = Option<String>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a member name")
    }

    fn visit_str<E: de::Error>(self, name: &str) -> Result<Self::Value, E> {
        let read = COMMIT_SCALAR_MEMBERS.contains(&name)
            || name == COMMIT_DATA_MEMBER
            || name == BYTES_MEMBER;
        Ok(read.then(|| name.to_owned()))
    }
}

fn parse_origin(value: &str) -> Result<Url, SpaceHostError> {
    let origin = Url::parse(value).map_err(|_| SpaceHostError::InvalidOrigin)?;
    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return Err(SpaceHostError::InvalidOrigin);
    }
    Ok(origin)
}

struct PrivateHostPolicy {
    origin: Url,
    cidrs: Vec<PrivateCidr>,
}

impl PrivateHostPolicy {
    fn from_env() -> Result<Option<Self>, SpaceHostError> {
        let origin = env::var("FEEDGEN_SPACE_SYNC_PRIVATE_HOST_ORIGIN").ok();
        let cidrs = env::var("FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS").ok();
        match (origin, cidrs) {
            (None, None) => Ok(None),
            (Some(origin), Some(cidrs)) => {
                let origin = parse_origin(&origin)
                    .map_err(|_| SpaceHostError::InvalidPrivateAddressPolicy)?;
                let cidrs = parse_private_cidrs(&cidrs)
                    .map_err(|_| SpaceHostError::InvalidPrivateAddressPolicy)?;
                Ok(Some(Self { origin, cidrs }))
            }
            _ => Err(SpaceHostError::InvalidPrivateAddressPolicy),
        }
    }
}

fn validate_addresses(
    origin: &Url,
    addresses: &[SocketAddr],
    private_policy: Option<&PrivateHostPolicy>,
) -> Result<SocketAddr, SpaceHostError> {
    let Some(address) = addresses.first().copied() else {
        return Err(SpaceHostError::Unreachable);
    };
    let private_cidrs = private_policy
        .filter(|policy| origin.origin() == policy.origin.origin())
        .map(|policy| policy.cidrs.as_slice());
    let all_public = addresses
        .iter()
        .all(|address| is_public_address(address.ip()));
    let all_trusted_private = private_cidrs.is_some_and(|cidrs| {
        addresses
            .iter()
            .all(|address| cidrs.iter().any(|cidr| cidr.contains(address.ip())))
    });
    if !all_public && !all_trusted_private {
        return Err(SpaceHostError::UnsafeAddress);
    }
    Ok(address)
}

fn validate_request(
    space_uri: &str,
    actor_did: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<(), SpaceHostError> {
    validate_identifiers(space_uri, actor_did)?;
    if cursor.is_some_and(|value| value.is_empty() || value.len() > MAX_CURSOR_BYTES)
        || limit == 0
        || limit > MAX_SPACE_PAGE_OPS
    {
        return Err(SpaceHostError::InvalidRequest);
    }
    Ok(())
}

fn validate_identifiers(space_uri: &str, actor_did: &str) -> Result<(), SpaceHostError> {
    if space_uri.is_empty()
        || space_uri.len() > 2_048
        || actor_did.is_empty()
        || actor_did.len() > 2_048
    {
        return Err(SpaceHostError::InvalidRequest);
    }
    Ok(())
}

fn classify_request_error(error: reqwest::Error) -> SpaceHostError {
    if error.is_timeout() {
        SpaceHostError::Timeout
    } else if error.is_redirect() {
        SpaceHostError::Redirect
    } else {
        SpaceHostError::Unreachable
    }
}

async fn response_bytes(
    mut response: reqwest::Response,
    maximum: usize,
) -> Result<Vec<u8>, SpaceHostError> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(SpaceHostError::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(classify_request_error)? {
        if bytes.len().saturating_add(chunk.len()) > maximum {
            return Err(SpaceHostError::ResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn request_error(response: reqwest::Response) -> SpaceHostError {
    let status = response.status().as_u16();
    let bytes = response_bytes(response, MAX_ERROR_BYTES)
        .await
        .unwrap_or_default();
    let code = serde_json::from_slice::<XrpcError>(&bytes)
        .ok()
        .and_then(|error| error.error);
    SpaceHostError::Request { status, code }
}

#[derive(Deserialize)]
struct XrpcError {
    error: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::{
        net::{Ipv4Addr, SocketAddr},
        sync::Arc,
    };

    use async_trait::async_trait;

    use super::{
        HostResolver, PinnedSpaceHostClient, PrivateHostPolicy, RepoOpsQuery, SpaceCredentialProof,
        SpaceHostError, parse_origin, validate_addresses, validate_request,
    };
    use crate::identity::parse_private_cidrs;

    struct TestProof;

    #[async_trait]
    impl SpaceCredentialProof for TestProof {
        async fn presentation_headers(
            &self,
            audience: &crate::identifier::Did,
        ) -> Result<crate::space_http_signature::SpaceHttpSignatureHeaders, SpaceHostError>
        {
            crate::space_http_signature::SpaceHttpSignatureKey::generate()
                .presentation_headers("credential", audience)
                .map_err(|_| SpaceHostError::Proof)
        }
    }

    const ACCEPT_SIGNATURE: &str = "sig1=(\"kem\")";

    fn ops_query<'a>(
        space_uri: &'a str,
        actor_did: &'a str,
        cursor: Option<&'a str>,
        limit: usize,
    ) -> RepoOpsQuery<'a> {
        RepoOpsQuery {
            space_uri,
            actor_did,
            since: None,
            cursor,
            limit,
        }
    }

    struct FixedResolver(Vec<SocketAddr>);

    #[async_trait]
    impl HostResolver for FixedResolver {
        async fn resolve(&self, _: &str, _: u16) -> Result<Vec<SocketAddr>, SpaceHostError> {
            Ok(self.0.clone())
        }
    }

    #[test]
    fn requires_a_clean_https_origin() {
        assert!(parse_origin("https://pds.example.test/").is_ok());
        for origin in [
            "http://pds.example.test/",
            "https://user@pds.example.test/",
            "https://pds.example.test/base",
            "https://pds.example.test/?query=yes",
            "https://pds.example.test/#fragment",
        ] {
            assert_eq!(parse_origin(origin), Err(SpaceHostError::InvalidOrigin));
        }
    }

    #[test]
    fn rejects_a_mixed_public_and_private_dns_answer() {
        let addresses = [
            SocketAddr::from((Ipv4Addr::new(1, 1, 1, 1), 443)),
            SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 443)),
        ];
        assert_eq!(
            validate_addresses(
                &parse_origin("https://pds.example.test").unwrap(),
                &addresses,
                None
            ),
            Err(SpaceHostError::UnsafeAddress)
        );
    }

    #[test]
    fn permits_private_dns_only_for_the_configured_pds_origin() {
        let policy = PrivateHostPolicy {
            origin: parse_origin("https://pds.internal.test").unwrap(),
            cidrs: parse_private_cidrs("172.25.111.0/24").unwrap(),
        };
        let address = SocketAddr::from((Ipv4Addr::new(172, 25, 111, 6), 443));
        assert_eq!(
            validate_addresses(&policy.origin, &[address], Some(&policy)),
            Ok(address)
        );
        assert_eq!(
            validate_addresses(
                &parse_origin("https://other.internal.test").unwrap(),
                &[address],
                Some(&policy)
            ),
            Err(SpaceHostError::UnsafeAddress)
        );
        assert_eq!(
            validate_addresses(
                &parse_origin("https://pds.internal.test:8443").unwrap(),
                &[address],
                Some(&policy)
            ),
            Err(SpaceHostError::UnsafeAddress)
        );
        assert_eq!(
            validate_addresses(
                &policy.origin,
                &[address, SocketAddr::from((Ipv4Addr::new(1, 1, 1, 1), 443))],
                Some(&policy)
            ),
            Err(SpaceHostError::UnsafeAddress)
        );
        let public = SocketAddr::from((Ipv4Addr::new(1, 1, 1, 1), 443));
        assert_eq!(
            validate_addresses(&policy.origin, &[public], Some(&policy)),
            Ok(public)
        );
        assert_eq!(
            validate_addresses(
                &policy.origin,
                &[SocketAddr::from((Ipv4Addr::new(172, 25, 111, 0), 443))],
                Some(&policy)
            ),
            Err(SpaceHostError::UnsafeAddress)
        );
    }

    #[tokio::test]
    async fn pins_only_a_validated_public_address() {
        let resolver = FixedResolver(vec![SocketAddr::from((Ipv4Addr::new(1, 1, 1, 1), 443))]);
        let client = PinnedSpaceHostClient::connect_with_resolver(
            "https://pds.example.test/",
            Arc::new(TestProof),
            &resolver,
        )
        .await
        .unwrap();
        assert_eq!(
            client
                .endpoint_url("com.atproto.space.listRepoOps")
                .unwrap()
                .as_str(),
            "https://pds.example.test/xrpc/com.atproto.space.listRepoOps"
        );
    }

    #[test]
    fn distinguishes_invalid_request_inputs_from_host_responses() {
        assert_eq!(
            validate_request("", "did:plc:member", None, 1),
            Err(SpaceHostError::InvalidRequest)
        );
    }

    #[tokio::test]
    async fn binds_repo_reads_to_each_owner_not_the_shared_host() {
        use crate::{
            identifier::Did, space_credential::GrantedSpaceCredential,
            space_http_signature::SpaceHttpSignatureKey,
        };
        use base64::{Engine, engine::general_purpose::STANDARD};
        use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
        let grant = Arc::new(
            GrantedSpaceCredential::new("rei".to_owned(), SpaceHttpSignatureKey::generate())
                .unwrap(),
        );
        let multikey = bs58::decode(grant.key_id().strip_prefix("did:key:z").unwrap())
            .into_vec()
            .unwrap();
        let key = VerifyingKey::from_sec1_bytes(&multikey[2..]).unwrap();
        let client = PinnedSpaceHostClient::connect_with_resolver(
            "https://pds.example.test",
            grant,
            &FixedResolver(vec!["1.1.1.1:443".parse().unwrap()]),
        )
        .await
        .unwrap();
        let space = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop";
        let rei = client
            .ops_request(&ops_query(space, "did:plc:rei", None, 10), ACCEPT_SIGNATURE)
            .await
            .unwrap()
            .build()
            .unwrap();
        let repeat = client
            .ops_request(
                &ops_query(space, "did:plc:rei", Some("next"), 20),
                ACCEPT_SIGNATURE,
            )
            .await
            .unwrap()
            .build()
            .unwrap();
        let misato = client
            .ops_request(
                &ops_query(space, "did:plc:misato", None, 10),
                ACCEPT_SIGNATURE,
            )
            .await
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            rei.headers()["authorization"],
            "Atproto-Space-Credential rei"
        );
        assert_eq!(rei.headers()["signature"], repeat.headers()["signature"]);
        assert_ne!(rei.headers()["signature"], misato.headers()["signature"]);
        assert_eq!(rei.headers()["atproto-space-audience"], "did:plc:rei");
        assert_eq!(misato.headers()["atproto-space-audience"], "did:plc:misato");
        assert!(rei.headers().get("dpop").is_none());
        let bytes = STANDARD
            .decode(
                rei.headers()["signature"]
                    .to_str()
                    .unwrap()
                    .strip_prefix("sig=:")
                    .unwrap()
                    .strip_suffix(':')
                    .unwrap(),
            )
            .unwrap();
        let signature = Signature::from_slice(&bytes).unwrap();
        for (audience, expected) in [("did:plc:rei", true), ("did:plc:misato", false)] {
            let audience = Did::parse(audience).unwrap();
            let base = format!(
                "\"authorization\": Atproto-Space-Credential rei\n\"atproto-space-audience\": {}\n\"@signature-params\": (\"authorization\" \"atproto-space-audience\");tag=\"atproto-space-credential\"",
                audience.as_str()
            );
            assert_eq!(key.verify(base.as_bytes(), &signature).is_ok(), expected);
        }
        assert!(
            client
                .ops_request(
                    &ops_query(space, "https://pds.example.test", None, 10),
                    ACCEPT_SIGNATURE
                )
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn sends_the_space_a_boundary_maps_to_as_the_space_parameter() {
        use crate::{
            space_credential::GrantedSpaceCredential, space_http_signature::SpaceHttpSignatureKey,
        };
        let grant = Arc::new(
            GrantedSpaceCredential::new("rei".to_owned(), SpaceHttpSignatureKey::generate())
                .unwrap(),
        );
        let client = PinnedSpaceHostClient::connect_with_resolver(
            "https://pds.example.test",
            grant,
            &FixedResolver(vec!["1.1.1.1:443".parse().unwrap()]),
        )
        .await
        .unwrap();
        let space =
            crate::credential_manager::boundary_to_space_uri("did:web:stratos.example.test/bebop")
                .unwrap();
        let request = client
            .ops_request(
                &ops_query(&space, "did:plc:rei", None, 10),
                ACCEPT_SIGNATURE,
            )
            .await
            .unwrap()
            .build()
            .unwrap();
        let sent: Vec<_> = request
            .url()
            .query_pairs()
            .filter(|(name, _)| name == "space")
            .map(|(_, value)| value.into_owned())
            .collect();
        assert_eq!(sent, [space]);
        assert_eq!(
            sent[0],
            "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop"
        );
    }
}

// In-process test host for the authenticated read: it answers through the
// transport seam and derives its secret with the code under test, so these
// tests prove flow (a fresh key per request, one refresh, at most one retry,
// the deadline, what is returned) and never the derivation, which the oracle
// vectors in `space_kem` and `space_mac` cover.
#[cfg(test)]
mod authenticated_read_tests {
    use std::{
        collections::VecDeque,
        net::SocketAddr,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use base64::{Engine, engine::general_purpose::STANDARD};
    use hmac::{Hmac, KeyInit, Mac};
    use p256::{SecretKey, elliptic_curve::sec1::ToSec1Point};
    use serde_json::json;
    use sha2::Sha256;
    use tokio::time::Instant;

    use super::*;
    use crate::{
        auth::IdentityResolutionError,
        identity::{DidDocumentSource, HttpIdentityKeyResolver},
        space_archive::ArchiveLimit,
        space_identity::AuthorKemKeyResolver,
        space_kem::{AuthorKemKey, decapsulate},
        space_mac::{MacDefect, MacVerifyError},
        space_signature_fields::{members_with_tag, parse_dictionary},
    };

    const REPO_ARCHIVE: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/repo-archive.json");
    const RECORD_CID: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/record-cid.json");
    const ARCHIVE_CHUNK_BYTES: usize = 97;

    const AUTHOR: &str = "did:plc:fayevalentine";
    const SPACE: &str = "at:space/did:web:bebop.example/zone.stratos.space.feed/crew";
    const OTHER_SPACE: &str = "at:space/did:web:bebop.example/zone.stratos.space.feed/ein";
    const REV: &str = "3jzfcijpj2z2d";
    const BODY_MARKER: &str = "See you space cowboy";
    const COMMIT_DATA: [u8; 32] = [7; 32];
    const ROOMY_DEADLINE: Duration = Duration::from_secs(30);

    fn private_key(byte: u8) -> SecretKey {
        SecretKey::from_slice(&[byte; 32]).expect("valid scalar")
    }

    fn public_key(private: &SecretKey) -> AuthorKemKey {
        AuthorKemKey::from_sec1_bytes(private.public_key().to_sec1_point(false).as_bytes())
            .expect("public key")
    }

    #[derive(Clone, Copy)]
    enum Listing {
        Serving,
        Unreachable,
        NoKemMethod,
    }

    // The DID document source behind a real resolver, so cached and refreshed
    // lookups behave as they do in production.
    struct Directory {
        published: Mutex<AuthorKemKey>,
        listing: Mutex<Listing>,
        fetches: AtomicUsize,
    }

    impl Directory {
        fn publishing(key: AuthorKemKey) -> Arc<Self> {
            Arc::new(Self {
                published: Mutex::new(key),
                listing: Mutex::new(Listing::Serving),
                fetches: AtomicUsize::new(0),
            })
        }

        fn publish(&self, key: AuthorKemKey) {
            *self.published.lock().unwrap() = key;
        }

        fn list_as(&self, listing: Listing) {
            *self.listing.lock().unwrap() = listing;
        }

        fn fetches(&self) -> usize {
            self.fetches.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl DidDocumentSource for Directory {
        async fn fetch(&self, did: &str) -> Result<String, IdentityResolutionError> {
            self.fetches.fetch_add(1, Ordering::SeqCst);
            let multikey = self
                .published
                .lock()
                .unwrap()
                .did_key()
                .strip_prefix("did:key:")
                .unwrap()
                .to_owned();
            let methods = match *self.listing.lock().unwrap() {
                Listing::Unreachable => return Err(IdentityResolutionError::Unavailable),
                Listing::NoKemMethod => json!([]),
                Listing::Serving => json!([{
                    "id": "#atproto_kem",
                    "type": "Multikey",
                    "publicKeyMultibase": multikey,
                }]),
            };
            Ok(json!({ "id": did, "verificationMethod": methods }).to_string())
        }
    }

    #[derive(Clone)]
    enum Answer {
        Honest,
        SignedForRepo(&'static str),
        SignedForSpace(&'static str),
        BodyCommitRev(&'static str),
        NoSignatureHeaders,
        SignatureHeaderTwice,
        UnpaddedCommitData,
        ReplayFirstResponse,
        Refused { status: u16, code: &'static str },
        TakesTooLong,
    }

    struct TestHost {
        private_key: Mutex<SecretKey>,
        script: Mutex<VecDeque<Answer>>,
        archive_script: Mutex<VecDeque<ArchiveAnswer>>,
        key_shares: Mutex<Vec<String>>,
        page_positions: Mutex<Vec<(Option<String>, Option<String>)>>,
        first_response: Mutex<Option<SignedReadResponse>>,
    }

    impl TestHost {
        fn holding(private_key: SecretKey, script: Vec<Answer>) -> Arc<Self> {
            Arc::new(Self {
                private_key: Mutex::new(private_key),
                script: Mutex::new(script.into()),
                archive_script: Mutex::new(VecDeque::new()),
                key_shares: Mutex::new(Vec::new()),
                page_positions: Mutex::new(Vec::new()),
                first_response: Mutex::new(None),
            })
        }

        fn serving_archives(&self, script: Vec<ArchiveAnswer>) {
            *self.archive_script.lock().unwrap() = script.into();
        }

        // The `since` and cursor of each page request, in the order sent.
        fn page_positions(&self) -> Vec<(Option<String>, Option<String>)> {
            self.page_positions.lock().unwrap().clone()
        }

        fn requests(&self) -> usize {
            self.key_shares.lock().unwrap().len()
        }

        fn key_shares(&self) -> Vec<String> {
            self.key_shares.lock().unwrap().clone()
        }

        fn respond(
            &self,
            key_share: &str,
            repo: &str,
            space: &str,
            body_rev: &str,
        ) -> SignedReadResponse {
            self.respond_with_data_text(
                key_share,
                repo,
                space,
                body_rev,
                &STANDARD.encode(COMMIT_DATA),
            )
        }

        // The MAC is computed over the header text as sent, whatever the
        // base64 form of `data` in it.
        fn respond_with_data_text(
            &self,
            key_share: &str,
            repo: &str,
            space: &str,
            body_rev: &str,
            data_text: &str,
        ) -> SignedReadResponse {
            let headers = self.commit_headers(key_share, repo, space, REV, data_text);
            let body = json!({
                "ops": [{ "text": BODY_MARKER }],
                "commit": {
                    "ver": 1,
                    "repo": repo,
                    "space": space,
                    "rev": body_rev,
                    "data": { "$bytes": STANDARD.encode(COMMIT_DATA).trim_end_matches('=') },
                },
            });
            SignedReadResponse {
                body: serde_json::to_vec(&body).unwrap(),
                headers,
            }
        }

        fn commit_headers(
            &self,
            key_share: &str,
            repo: &str,
            space: &str,
            rev: &str,
            data_text: &str,
        ) -> CommitResponseHeaders {
            let secret = decapsulate(&self.private_key.lock().unwrap(), key_share).unwrap();
            let commit_header = format!(
                "ver=1, repo=\"{repo}\", space=\"{space}\", rev=\"{rev}\", data=:{data_text}:"
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
    }

    fn requested_key_share(accept_signature: &str) -> String {
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

    #[async_trait]
    impl RepoOpsTransport for TestHost {
        async fn send(
            &self,
            query: &RepoOpsQuery<'_>,
            accept_signature: &str,
        ) -> Result<SignedReadResponse, SpaceHostError> {
            let key_share = requested_key_share(accept_signature);
            self.key_shares.lock().unwrap().push(key_share.clone());
            self.page_positions.lock().unwrap().push((
                query.since.map(str::to_owned),
                query.cursor.map(str::to_owned),
            ));
            let answer = self
                .script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Answer::Honest);
            let honest =
                |repo: &str, space: &str, rev: &str| self.respond(&key_share, repo, space, rev);
            let response = match answer {
                Answer::Honest => honest(query.actor_did, query.space_uri, REV),
                Answer::SignedForRepo(repo) => honest(repo, query.space_uri, REV),
                Answer::SignedForSpace(space) => honest(query.actor_did, space, REV),
                Answer::BodyCommitRev(rev) => {
                    let mut response = honest(query.actor_did, query.space_uri, REV);
                    let mut body: Value = serde_json::from_slice(&response.body).unwrap();
                    body["commit"]["rev"] = json!(rev);
                    response.body = serde_json::to_vec(&body).unwrap();
                    response
                }
                Answer::NoSignatureHeaders => SignedReadResponse {
                    headers: CommitResponseHeaders::default(),
                    ..honest(query.actor_did, query.space_uri, REV)
                },
                Answer::SignatureHeaderTwice => {
                    let mut response = honest(query.actor_did, query.space_uri, REV);
                    let line = response.headers.signature[0].clone();
                    response.headers.signature.push(line);
                    response
                }
                Answer::UnpaddedCommitData => self.respond_with_data_text(
                    &key_share,
                    query.actor_did,
                    query.space_uri,
                    REV,
                    STANDARD.encode(COMMIT_DATA).trim_end_matches('='),
                ),
                Answer::ReplayFirstResponse => self
                    .first_response
                    .lock()
                    .unwrap()
                    .clone()
                    .expect("a first response to replay"),
                Answer::Refused { status, code } => {
                    return Err(SpaceHostError::Request {
                        status,
                        code: Some(code.to_owned()),
                    });
                }
                Answer::TakesTooLong => {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    honest(query.actor_did, query.space_uri, REV)
                }
            };
            self.first_response
                .lock()
                .unwrap()
                .get_or_insert_with(|| response.clone());
            Ok(response)
        }
    }

    #[derive(Clone)]
    struct Edit {
        at: usize,
        remove: usize,
        insert: Vec<u8>,
    }

    fn hex_bytes(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex digit"))
            .collect()
    }

    fn archive_fixture() -> Value {
        serde_json::from_str(REPO_ARCHIVE).expect("fixture")
    }

    fn fixture_archive(section: &str) -> Vec<u8> {
        STANDARD
            .decode(archive_fixture()[section]["bytes"].as_str().unwrap())
            .unwrap()
    }

    fn fixture_edits() -> Vec<(String, Edit)> {
        archive_fixture()["refused"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row["name"].as_str().unwrap().to_owned(),
                    Edit {
                        at: row["at"].as_u64().unwrap() as usize,
                        remove: row["remove"].as_u64().unwrap() as usize,
                        insert: hex_bytes(row["insert"].as_str().unwrap()),
                    },
                )
            })
            .collect()
    }

    fn edited(archive: &[u8], edit: &Edit) -> Vec<u8> {
        let mut bytes = archive[..edit.at].to_vec();
        bytes.extend_from_slice(&edit.insert);
        bytes.extend_from_slice(&archive[edit.at + edit.remove..]);
        bytes
    }

    // The metadata's own repo, space, rev and data, which an honest host signs.
    fn commit_of_archive(archive: &[u8]) -> (String, String, String, String) {
        let mut reader = ArchiveReader::new();
        reader.push(archive).unwrap();
        let Some(ArchiveItem::Metadata(metadata)) = reader.next_item().unwrap() else {
            panic!("an archive starts with its metadata");
        };
        let text = |name: &str| metadata[name].as_str().unwrap().to_owned();
        let data = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(metadata["data"]["$bytes"].as_str().unwrap())
            .unwrap();
        (
            text("repo"),
            text("space"),
            text("rev"),
            STANDARD.encode(data),
        )
    }

    #[derive(Clone)]
    enum ArchiveAnswer {
        Honest,
        // The header signs the fixture's commit; the body is another archive.
        Body(Vec<u8>),
        // An honest host answering with another archive and signing its commit.
        SignedBody(Vec<u8>),
        HeaderForRev(&'static str),
        ContentType(Option<&'static str>),
        Refused { status: u16, code: &'static str },
        StallsAfterFirstChunk,
        BodyFailsAfterFirstChunk,
    }

    enum AfterChunks {
        End,
        Stall,
        Fail,
    }

    struct ScriptedBody {
        chunks: VecDeque<Vec<u8>>,
        after: AfterChunks,
    }

    #[async_trait]
    impl ArchiveBody for ScriptedBody {
        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, SpaceHostError> {
            if let Some(chunk) = self.chunks.pop_front() {
                return Ok(Some(chunk));
            }
            match self.after {
                AfterChunks::End => Ok(None),
                AfterChunks::Stall => {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    Ok(None)
                }
                AfterChunks::Fail => Err(SpaceHostError::Unreachable),
            }
        }
    }

    #[async_trait]
    impl RepoArchiveTransport for TestHost {
        async fn send_archive(
            &self,
            _query: &RepoArchiveQuery<'_>,
            accept_signature: &str,
        ) -> Result<SignedArchiveResponse, SpaceHostError> {
            let key_share = requested_key_share(accept_signature);
            self.key_shares.lock().unwrap().push(key_share.clone());
            let answer = self
                .archive_script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(ArchiveAnswer::Honest);
            let fixture = fixture_archive("archive");
            let signed_for = |archive: &[u8], rev: Option<&str>| {
                let (repo, space, own_rev, data) = commit_of_archive(archive);
                self.commit_headers(&key_share, &repo, &space, rev.unwrap_or(&own_rev), &data)
            };
            let (body, headers, content_type, after) = match answer {
                ArchiveAnswer::Honest => {
                    let headers = signed_for(&fixture, None);
                    (fixture, headers, Some(STAR_CONTENT_TYPE), AfterChunks::End)
                }
                ArchiveAnswer::Body(body) => {
                    let headers = signed_for(&fixture, None);
                    (body, headers, Some(STAR_CONTENT_TYPE), AfterChunks::End)
                }
                ArchiveAnswer::SignedBody(body) => {
                    let headers = signed_for(&body, None);
                    (body, headers, Some(STAR_CONTENT_TYPE), AfterChunks::End)
                }
                ArchiveAnswer::HeaderForRev(rev) => {
                    let headers = signed_for(&fixture, Some(rev));
                    (fixture, headers, Some(STAR_CONTENT_TYPE), AfterChunks::End)
                }
                ArchiveAnswer::ContentType(content_type) => {
                    let headers = signed_for(&fixture, None);
                    (fixture, headers, content_type, AfterChunks::End)
                }
                ArchiveAnswer::Refused { status, code } => {
                    return Err(SpaceHostError::Request {
                        status,
                        code: Some(code.to_owned()),
                    });
                }
                ArchiveAnswer::StallsAfterFirstChunk => {
                    let headers = signed_for(&fixture, None);
                    (
                        fixture,
                        headers,
                        Some(STAR_CONTENT_TYPE),
                        AfterChunks::Stall,
                    )
                }
                ArchiveAnswer::BodyFailsAfterFirstChunk => {
                    let headers = signed_for(&fixture, None);
                    (fixture, headers, Some(STAR_CONTENT_TYPE), AfterChunks::Fail)
                }
            };
            let mut chunks: VecDeque<Vec<u8>> = body
                .chunks(ARCHIVE_CHUNK_BYTES)
                .map(<[u8]>::to_vec)
                .collect();
            if !matches!(after, AfterChunks::End) {
                chunks.truncate(1);
            }
            Ok(SignedArchiveResponse {
                content_type: content_type.map(str::to_owned),
                headers,
                body: Box::new(ScriptedBody { chunks, after }),
            })
        }
    }

    struct Setup {
        directory: Arc<Directory>,
        resolver: HttpIdentityKeyResolver,
        host: Arc<TestHost>,
    }

    fn setup(script: Vec<Answer>) -> Setup {
        let author = private_key(0x22);
        let directory = Directory::publishing(public_key(&author));
        Setup {
            resolver: HttpIdentityKeyResolver::with_document_source(directory.clone()),
            directory,
            host: TestHost::holding(author, script),
        }
    }

    async fn read(setup: &Setup) -> Result<AuthenticatedPage, AuthenticatedReadError> {
        read_with_deadline(setup, Instant::now() + ROOMY_DEADLINE).await
    }

    async fn read_with_deadline(
        setup: &Setup,
        deadline: Instant,
    ) -> Result<AuthenticatedPage, AuthenticatedReadError> {
        authenticated_read(
            setup.host.as_ref(),
            &setup.resolver as &dyn AuthorKemKeyResolver,
            &RepoOpsQuery {
                space_uri: SPACE,
                actor_did: AUTHOR,
                since: None,
                cursor: None,
                limit: 100,
            },
            deadline,
        )
        .await
    }

    fn authentication_failure(defect: MacDefect) -> AuthenticatedReadError {
        AuthenticatedReadError::Authentication(MacVerifyError::Invalid(defect))
    }

    #[tokio::test]
    async fn a_verified_read_returns_the_body_bytes_with_the_commit() {
        let setup = setup(vec![]);
        let page = read(&setup).await.expect("verified page");
        assert_eq!(page.commit().repo(), AUTHOR);
        assert_eq!(page.commit().space(), SPACE);
        assert_eq!(page.commit().rev(), REV);
        let body: Value = serde_json::from_slice(page.body()).unwrap();
        assert_eq!(body["ops"][0]["text"], BODY_MARKER);
        assert_eq!(setup.host.requests(), 1);
    }

    #[tokio::test]
    async fn two_reads_send_two_different_key_shares() {
        let setup = setup(vec![]);
        read(&setup).await.expect("first read");
        read(&setup).await.expect("second read");
        let shares = setup.host.key_shares();
        assert_eq!(shares.len(), 2);
        assert_ne!(shares[0], shares[1]);
        assert_eq!(
            setup.directory.fetches(),
            1,
            "the second read used the cache"
        );
    }

    #[tokio::test]
    async fn a_response_made_for_the_first_request_does_not_verify_for_a_second() {
        let setup = setup(vec![Answer::Honest, Answer::ReplayFirstResponse]);
        read(&setup).await.expect("first read");
        let error = read(&setup).await.err().expect("replay refused");
        assert_eq!(error, authentication_failure(MacDefect::KeyShareMismatch));
        assert_eq!(setup.host.requests(), 2);
    }

    #[tokio::test]
    async fn a_stale_kem_key_is_refreshed_and_one_new_request_with_a_new_key_share_verifies() {
        let setup = setup(vec![]);
        let rotated = private_key(0x44);
        *setup.host.private_key.lock().unwrap() = rotated.clone();
        // The resolver has not seen the rotation yet.
        let cached = setup.resolver.author_kem_key(AUTHOR).await.unwrap();
        assert_eq!(cached, public_key(&private_key(0x22)));
        setup.directory.publish(public_key(&rotated));

        let page = read(&setup).await.expect("verified after the retry");

        let shares = setup.host.key_shares();
        assert_eq!(shares.len(), 2, "exactly two requests");
        assert_ne!(shares[0], shares[1]);
        assert_eq!(page.commit().repo(), AUTHOR);
        assert_eq!(setup.directory.fetches(), 2, "one lookup, one refresh");
    }

    #[tokio::test]
    async fn an_unchanged_key_after_the_refresh_fails_without_a_second_request() {
        let setup = setup(vec![]);
        *setup.host.private_key.lock().unwrap() = private_key(0x44);

        let error = read(&setup).await.err().expect("mismatch");

        assert_eq!(
            error,
            AuthenticatedReadError::Authentication(MacVerifyError::MacMismatch)
        );
        assert_eq!(setup.host.requests(), 1);
        assert_eq!(setup.directory.fetches(), 2, "the key was refreshed once");
    }

    #[tokio::test]
    async fn a_second_wrong_response_fails_after_exactly_two_requests() {
        let setup = setup(vec![]);
        // The host answers under a key the directory never publishes.
        *setup.host.private_key.lock().unwrap() = private_key(0x55);
        setup.resolver.author_kem_key(AUTHOR).await.unwrap();
        setup.directory.publish(public_key(&private_key(0x66)));

        let error = read(&setup).await.err().expect("still wrong");

        assert_eq!(
            error,
            AuthenticatedReadError::Authentication(MacVerifyError::MacMismatch)
        );
        assert_eq!(setup.host.requests(), 2);
    }

    #[tokio::test]
    async fn a_body_commit_that_differs_from_the_signed_header_fails_without_a_retry() {
        let setup = setup(vec![Answer::BodyCommitRev("3jzfcijpj2z2c")]);
        let error = read(&setup).await.err().expect("body differs");
        assert_eq!(
            error,
            authentication_failure(MacDefect::CommitDiffersFromSignedHeader)
        );
        assert_eq!(setup.host.requests(), 1);
        assert_eq!(setup.directory.fetches(), 1);
    }

    #[tokio::test]
    async fn a_response_naming_another_repo_or_space_fails_without_a_retry() {
        for answer in [
            Answer::SignedForRepo("did:plc:jetblack"),
            Answer::SignedForSpace(OTHER_SPACE),
        ] {
            let setup = setup(vec![answer]);
            let error = read(&setup).await.err().expect("wrong request");
            assert_eq!(error, authentication_failure(MacDefect::RequestMismatch));
            assert_eq!(setup.host.requests(), 1);
        }
    }

    #[tokio::test]
    async fn a_response_without_the_new_authentication_returns_no_body() {
        for (answer, defect) in [
            (Answer::NoSignatureHeaders, MacDefect::HeaderMissing),
            (Answer::SignatureHeaderTwice, MacDefect::HeaderRepeated),
        ] {
            let setup = setup(vec![answer]);
            let error = read(&setup).await.err().expect("refused");
            assert_eq!(error, authentication_failure(defect));
            assert_eq!(
                setup.host.requests(),
                1,
                "a missing header is not a stale key"
            );
        }
    }

    // A field the oracle and this verifier would MAC differently is refused
    // on purpose, as an invalid response rather than a stale key.
    #[tokio::test]
    async fn an_unpadded_commit_data_fails_after_one_request_with_no_refresh() {
        let setup = setup(vec![Answer::UnpaddedCommitData]);
        let error = read(&setup).await.err().expect("refused");
        assert_eq!(
            error,
            authentication_failure(MacDefect::NonCanonicalByteSequence)
        );
        assert_eq!(setup.host.requests(), 1);
        assert_eq!(setup.directory.fetches(), 1, "the key was not refreshed");
    }

    #[tokio::test]
    async fn a_refusal_status_is_the_existing_request_error() {
        let setup = setup(vec![Answer::Refused {
            status: 400,
            code: "InvalidSpaceMac",
        }]);
        let error = read(&setup).await.err().expect("refused");
        assert_eq!(
            error,
            AuthenticatedReadError::Host(SpaceHostError::Request {
                status: 400,
                code: Some("InvalidSpaceMac".to_owned()),
            })
        );
        assert_eq!(setup.host.requests(), 1);
    }

    #[tokio::test]
    async fn a_deadline_that_passes_during_the_second_request_fails_with_no_third_request() {
        let setup = setup(vec![Answer::Honest, Answer::TakesTooLong]);
        let rotated = private_key(0x44);
        *setup.host.private_key.lock().unwrap() = rotated.clone();
        setup.resolver.author_kem_key(AUTHOR).await.unwrap();
        setup.directory.publish(public_key(&rotated));
        // The first answer is under the old key and fails the MAC; the second
        // request then outlives the deadline.
        let deadline = Instant::now() + Duration::from_millis(300);

        let started = Instant::now();
        let error = read_with_deadline(&setup, deadline)
            .await
            .err()
            .expect("late");

        assert_eq!(error, AuthenticatedReadError::DeadlineExceeded);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(setup.host.requests(), 2);
    }

    #[tokio::test]
    async fn a_deadline_that_has_passed_sends_nothing() {
        let setup = setup(vec![]);
        let error = read_with_deadline(&setup, Instant::now())
            .await
            .err()
            .expect("late");
        assert_eq!(error, AuthenticatedReadError::DeadlineExceeded);
        assert_eq!(setup.host.requests(), 0);
    }

    #[tokio::test]
    async fn an_unavailable_kem_lookup_defers_and_sends_nothing() {
        let setup = setup(vec![]);
        setup.directory.list_as(Listing::Unreachable);
        let error = read(&setup).await.err().expect("deferred");
        assert_eq!(error, AuthenticatedReadError::KemKeyUnavailable);
        assert!(error.is_deferred());
        assert_eq!(setup.host.requests(), 0);
    }

    #[tokio::test]
    async fn an_invalid_kem_lookup_fails_and_sends_nothing() {
        let setup = setup(vec![]);
        setup.directory.list_as(Listing::NoKemMethod);
        let error = read(&setup).await.err().expect("failed");
        assert_eq!(error, AuthenticatedReadError::KemKeyInvalid);
        assert!(!error.is_deferred());
        assert_eq!(setup.host.requests(), 0);
    }
    // Positions in the request.

    #[tokio::test]
    async fn since_and_cursor_reach_the_request_as_given() {
        let setup = setup(vec![]);
        let query = |since, cursor| RepoOpsQuery {
            space_uri: SPACE,
            actor_did: AUTHOR,
            since,
            cursor,
            limit: 100,
        };
        let deadline = Instant::now() + ROOMY_DEADLINE;
        let keys = &setup.resolver as &dyn AuthorKemKeyResolver;
        let host = setup.host.as_ref();

        authenticated_read(host, keys, &query(None, None), deadline)
            .await
            .unwrap();
        authenticated_read(host, keys, &query(Some("3jzfcijpj2z2a"), None), deadline)
            .await
            .unwrap();
        authenticated_read(
            host,
            keys,
            &query(Some("3jzfcijpj2z2a"), Some("3jzfcijpj2z2c/4")),
            deadline,
        )
        .await
        .unwrap();

        assert_eq!(
            setup.host.page_positions(),
            vec![
                (None, None),
                (Some("3jzfcijpj2z2a".to_owned()), None),
                (
                    Some("3jzfcijpj2z2a".to_owned()),
                    Some("3jzfcijpj2z2c/4".to_owned())
                ),
            ]
        );
    }

    async fn client_with_grant() -> PinnedSpaceHostClient {
        use crate::{
            space_credential::GrantedSpaceCredential, space_http_signature::SpaceHttpSignatureKey,
        };
        PinnedSpaceHostClient::connect_with_resolver(
            "https://pds.example.test",
            Arc::new(
                GrantedSpaceCredential::new("rei".to_owned(), SpaceHttpSignatureKey::generate())
                    .unwrap(),
            ),
            &FixedAddress,
        )
        .await
        .unwrap()
    }

    struct FixedAddress;

    #[async_trait]
    impl HostResolver for FixedAddress {
        async fn resolve(&self, _: &str, _: u16) -> Result<Vec<SocketAddr>, SpaceHostError> {
            Ok(vec!["1.1.1.1:443".parse().unwrap()])
        }
    }

    fn pairs(request: &reqwest::Request) -> Vec<(String, String)> {
        request
            .url()
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect()
    }

    #[tokio::test]
    async fn the_page_request_carries_since_beside_the_cursor_and_asks_for_the_mac() {
        let client = client_with_grant().await;
        let ops_request = |since, cursor| {
            let client = &client;
            async move {
                client
                    .ops_request(
                        &RepoOpsQuery {
                            space_uri: SPACE,
                            actor_did: AUTHOR,
                            since,
                            cursor,
                            limit: 50,
                        },
                        "mac=(\"@method\");keyid=\"k\";tag=\"atproto-space-commit\"",
                    )
                    .await
                    .unwrap()
                    .build()
                    .unwrap()
            }
        };

        let both = ops_request(Some("3jzfcijpj2z2a"), Some("3jzfcijpj2z2c/4")).await;
        let neither = ops_request(None, None).await;

        let names = |request: &reqwest::Request| -> Vec<String> {
            pairs(request).into_iter().map(|(name, _)| name).collect()
        };
        assert_eq!(
            pairs(&both),
            [
                ("space", SPACE),
                ("repo", AUTHOR),
                ("limit", "50"),
                ("since", "3jzfcijpj2z2a"),
                ("cursor", "3jzfcijpj2z2c/4"),
            ]
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
        );
        assert_eq!(names(&neither), ["space", "repo", "limit"]);
        for request in [&both, &neither] {
            assert_eq!(request.url().path(), "/xrpc/com.atproto.space.listRepoOps");
            assert_eq!(request.headers()["accept"], "application/json");
            assert_eq!(
                request.headers()["accept-signature"],
                "mac=(\"@method\");keyid=\"k\";tag=\"atproto-space-commit\""
            );
            assert_eq!(request.headers()["atproto-space-audience"], AUTHOR);
        }
    }

    #[tokio::test]
    async fn a_since_that_cannot_be_a_revision_is_not_sent() {
        let client = client_with_grant().await;
        for since in ["", &"3".repeat(MAX_REV_BYTES + 1)] {
            let outcome = client
                .ops_request(
                    &RepoOpsQuery {
                        space_uri: SPACE,
                        actor_did: AUTHOR,
                        since: Some(since),
                        cursor: None,
                        limit: 50,
                    },
                    "mac",
                )
                .await;
            assert_eq!(outcome.err(), Some(SpaceHostError::InvalidRequest));
        }
    }

    #[tokio::test]
    async fn the_archive_request_asks_for_a_star_body_and_the_mac_like_a_page_does() {
        let client = client_with_grant().await;
        let accept_signature = "mac=(\"@method\");keyid=\"k\";tag=\"atproto-space-commit\"";
        let archive = client
            .archive_request(
                &RepoArchiveQuery {
                    space_uri: SPACE,
                    actor_did: AUTHOR,
                },
                accept_signature,
            )
            .await
            .unwrap()
            .build()
            .unwrap();
        let page = client
            .ops_request(
                &RepoOpsQuery {
                    space_uri: SPACE,
                    actor_did: AUTHOR,
                    since: None,
                    cursor: None,
                    limit: 50,
                },
                accept_signature,
            )
            .await
            .unwrap()
            .build()
            .unwrap();

        assert_eq!(archive.url().path(), "/xrpc/com.atproto.space.getRepo");
        assert_eq!(
            pairs(&archive),
            [("space", SPACE), ("repo", AUTHOR)]
                .map(|(name, value)| (name.to_owned(), value.to_owned()))
        );
        assert_eq!(archive.headers()["accept"], "application/vnd.dasl.star");
        for name in [
            "accept-signature",
            "authorization",
            "atproto-space-audience",
        ] {
            assert_eq!(archive.headers()[name], page.headers()[name], "{name}");
        }
        assert!(archive.headers().contains_key("signature"));
        assert!(archive.headers().contains_key("signature-input"));
        assert_eq!(archive.timeout(), Some(&ARCHIVE_REQUEST_TIMEOUT));
    }

    // The archive read.

    fn archive_setup(script: Vec<ArchiveAnswer>) -> Setup {
        let setup = setup(vec![]);
        setup.host.serving_archives(script);
        setup
    }

    async fn read_archive_before(
        setup: &Setup,
        deadline: Instant,
        decode: &RecordDecoder<'_>,
    ) -> Result<AuthenticatedArchive, AuthenticatedReadError> {
        authenticated_archive_read(
            setup.host.as_ref(),
            &setup.resolver as &dyn AuthorKemKeyResolver,
            &RepoArchiveQuery {
                space_uri: SPACE,
                actor_did: AUTHOR,
            },
            deadline,
            decode,
            &ValueBudget::unlimited_for_tests(),
        )
        .await
    }

    async fn read_archive(setup: &Setup) -> Result<AuthenticatedArchive, AuthenticatedReadError> {
        read_archive_before(setup, Instant::now() + ROOMY_DEADLINE, &decode_record).await
    }

    fn oracle_record(name: &str) -> (Cid, Value) {
        let vectors: Value = serde_json::from_str(RECORD_CID).unwrap();
        let row = vectors["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == name)
            .unwrap();
        let cid = row["oracle"].as_str().unwrap().rsplit(' ').next().unwrap();
        (
            Cid::try_from(cid).unwrap(),
            serde_json::from_str(row["json"].as_str().unwrap()).unwrap(),
        )
    }

    #[tokio::test]
    async fn the_fixture_archive_is_read_to_its_commit_and_its_records() {
        let setup = archive_setup(vec![]);

        let archive = read_archive(&setup).await.expect("verified archive");

        let (repo, space, rev, data) = commit_of_archive(&fixture_archive("archive"));
        assert_eq!(archive.commit().repo(), repo);
        assert_eq!(archive.commit().space(), space);
        assert_eq!(archive.commit().rev(), rev);
        assert_eq!(
            STANDARD.encode(archive.commit().data()),
            data,
            "the commit is the metadata's, as the MAC covered it"
        );
        let expected = [
            ("app.bsky.feed.like", "ed", "a like with a strong reference"),
            ("app.bsky.feed.repost", "jet", "a repost"),
            ("app.bsky.graph.follow", "faye", "a follow"),
            ("zone.stratos.feed.post", "swordfish", "a post"),
        ];
        let read: Vec<_> = archive
            .records()
            .iter()
            .map(|record| (record.path.collection(), record.path.rkey()))
            .collect();
        assert_eq!(
            read,
            expected.map(|(collection, rkey, _)| (collection, rkey))
        );
        for (record, (collection, _, name)) in archive.records().iter().zip(expected) {
            let (cid, value) = oracle_record(name);
            let kept = is_projected_collection(collection).then_some(&value);
            assert_eq!((record.cid, record.value.as_ref()), (cid, kept), "{name}");
        }
        assert_eq!(setup.host.requests(), 1);
        let (commit, records) = archive.into_parts();
        assert_eq!(commit.repo(), AUTHOR);
        assert_eq!(records.len(), 4);
    }

    fn star_varint(mut value: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        while value >= 0x80 {
            bytes.push((value % 0x80) as u8 | 0x80);
            value /= 0x80;
        }
        bytes.push(value as u8);
        bytes
    }

    fn star_framed(bytes: &[u8]) -> Vec<u8> {
        let mut out = star_varint(bytes.len());
        out.extend_from_slice(bytes);
        out
    }

    // An archive of `records` over the repo and space the tests use, in path
    // order, with a commit the in-process host signs as it is. The commit's data
    // is not the records' hash: the store checks that, not the read.
    fn archive_of_records(records: &[(&str, &str, Value)]) -> Vec<u8> {
        archive_of_record_bytes(
            records
                .iter()
                .map(|(collection, rkey, value)| {
                    (
                        format!("{collection}/{rkey}"),
                        crate::space_record::encode_record(value).expect("encodes"),
                    )
                })
                .collect(),
        )
    }

    fn archive_of_record_bytes(mut pairs: Vec<(String, Vec<u8>)>) -> Vec<u8> {
        let metadata = crate::space_record::encode_record(&json!({
            "$type": crate::space_archive::REPO_ARCHIVE_TYPE,
            "ver": 1,
            "repo": AUTHOR,
            "space": SPACE,
            "rev": REV,
            "data": { "$bytes": STANDARD.encode(COMMIT_DATA).trim_end_matches('=') },
        }))
        .expect("encodes");
        pairs.sort();
        let mut archive = vec![0x2a, 0x6c, 0x01, 0x00];
        archive.extend(star_framed(&metadata));
        for (path, bytes) in pairs {
            archive.push(0x01);
            archive.extend(star_framed(path.as_bytes()));
            archive.extend(star_framed(&bytes));
        }
        archive.push(0x00);
        archive
    }

    async fn read_archive_within(
        setup: &Setup,
        decode: &RecordDecoder<'_>,
        budget: &ValueBudget,
    ) -> Result<AuthenticatedArchive, AuthenticatedReadError> {
        authenticated_archive_read(
            setup.host.as_ref(),
            &setup.resolver as &dyn AuthorKemKeyResolver,
            &RepoArchiveQuery {
                space_uri: SPACE,
                actor_did: AUTHOR,
            },
            Instant::now() + ROOMY_DEADLINE,
            decode,
            budget,
        )
        .await
    }

    fn follow_of(name: &str) -> Value {
        json!({ "$type": "app.bsky.graph.follow", "subject": format!("did:plc:{name}"), "tags": ["bounty", "hunter"] })
    }

    fn post_of(text: &str) -> Value {
        json!({ "$type": "zone.stratos.feed.post", "text": text, "langs": ["en", "ja"] })
    }

    #[tokio::test]
    async fn the_records_of_a_collection_the_projection_does_not_read_come_back_without_a_value() {
        let follows = [
            ("app.bsky.graph.follow", "faye", follow_of("fayevalentine")),
            ("app.bsky.graph.follow", "jet", follow_of("jetblack")),
            (
                "moe.bebop.crew",
                "spike",
                json!({ "$type": "moe.bebop.crew", "name": "Spike" }),
            ),
        ];
        let archive = archive_of_records(&follows);
        let setup = archive_setup(vec![ArchiveAnswer::SignedBody(archive)]);
        let budget = ValueBudget::with_limit(0);

        let read = read_archive_within(&setup, &decode_record, &budget)
            .await
            .expect("verified archive");

        assert_eq!(read.records().len(), 3);
        for (record, (_, _, value)) in read.records().iter().zip(
            // Archive order is the bytes of the joined path.
            [&follows[0], &follows[1], &follows[2]],
        ) {
            assert_eq!(record.value, None);
            assert_eq!(
                record.cid,
                crate::space_record::record_cid(
                    &crate::space_record::encode_record(value).unwrap()
                )
            );
        }
        assert_eq!(budget.used(), 0, "dropped values are not counted");
    }

    #[tokio::test]
    async fn a_value_is_dropped_only_after_it_was_decoded_and_held_to_its_bytes() {
        // A follow whose map keys are out of canonical order is still refused:
        // the value is dropped after the check, not instead of it.
        let archive = archive_of_record_bytes(vec![(
            "app.bsky.graph.follow/faye".to_owned(),
            vec![0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02],
        )]);
        let setup = archive_setup(vec![ArchiveAnswer::SignedBody(archive)]);
        let calls = AtomicUsize::new(0);

        let error = read_archive_within(&setup, &counting(&calls), &ValueBudget::with_limit(0))
            .await
            .err()
            .expect("refused");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(
            matches!(error, AuthenticatedReadError::ArchiveRecord(_)),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn the_values_of_the_records_it_reads_are_charged_nested_values_included() {
        let records = [
            ("zone.stratos.feed.post", "ein", post_of("Woof")),
            (
                "zone.stratos.feed.post",
                "swordfish",
                post_of("See you space cowboy"),
            ),
            (
                "app.bsky.feed.like",
                "ed",
                json!({ "$type": "app.bsky.feed.like", "subject": { "uri": "at://did:plc:a/zone.stratos.feed.post/b" } }),
            ),
        ];
        // Two posts of a map, its type, its text and a two-item list (six
        // each) and a like of a map, its type and a map and its uri (four).
        let values = 6 + 6 + 4;
        let archive = archive_of_records(&records);

        let exact = ValueBudget::with_limit(values);
        let setup = archive_setup(vec![ArchiveAnswer::SignedBody(archive.clone())]);
        let read = read_archive_within(&setup, &decode_record, &exact)
            .await
            .expect("exactly at the limit is accepted");
        assert_eq!(exact.used(), values);
        assert!(read.records().iter().all(|record| record.value.is_some()));

        let short = ValueBudget::with_limit(values - 1);
        let setup = archive_setup(vec![ArchiveAnswer::SignedBody(archive)]);
        let error = read_archive_within(&setup, &decode_record, &short)
            .await
            .err()
            .expect("one value over");
        assert_eq!(error, AuthenticatedReadError::OverBudget);
    }

    #[tokio::test]
    async fn an_archive_past_the_budget_is_refused_at_the_record_that_passes_it_and_no_later_one_is_decoded()
     {
        let records: Vec<(&str, String, Value)> = (0..6)
            .map(|at| {
                (
                    "zone.stratos.feed.post",
                    format!("post{at}"),
                    post_of("Bang"),
                )
            })
            .collect();
        let borrowed: Vec<(&str, &str, Value)> = records
            .iter()
            .map(|(collection, rkey, value)| (*collection, rkey.as_str(), value.clone()))
            .collect();
        let per_record = crate::space_value_budget::count_values(&post_of("Bang"));
        // Two records fit; the third passes the limit.
        let budget = ValueBudget::with_limit(per_record * 2 + per_record - 1);
        let setup = archive_setup(vec![ArchiveAnswer::SignedBody(archive_of_records(
            &borrowed,
        ))]);
        let calls = AtomicUsize::new(0);

        let error = read_archive_within(&setup, &counting(&calls), &budget)
            .await
            .err()
            .expect("over budget");

        assert_eq!(error, AuthenticatedReadError::OverBudget);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "the third is the last decoded"
        );
        assert_eq!(
            budget.used(),
            per_record * 2,
            "the refused record took nothing"
        );
    }

    #[tokio::test]
    async fn the_fixture_archive_replaces_to_the_rows_it_did_when_every_value_was_kept() {
        use crate::store::{
            EncryptedStore, PdsSpaceMember, StorageKey, VerifiedSpaceRecord, VerifiedSpaceTarget,
        };
        const BOUNDARY: &str = "did:web:bebop.example/crew";
        const OBSERVED: &str = "2026-09-22T00:00:00.000Z";
        const RETAINED: &str = "2026-09-23T00:00:00.000Z";
        let replaced = |records: Vec<VerifiedSpaceRecord>, commit: &MacVerifiedCommit| {
            let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
            store
                .replace_pds_space_members(
                    BOUNDARY,
                    vec![PdsSpaceMember {
                        did: AUTHOR.to_owned(),
                    }],
                    OBSERVED,
                )
                .unwrap();
            let target = VerifiedSpaceTarget {
                boundary: BOUNDARY.to_owned(),
                space_uri: SPACE.to_owned(),
                actor_did: AUTHOR.to_owned(),
                host: "https://pds.bebop.example".to_owned(),
                generation: store
                    .pds_member_generation(BOUNDARY, AUTHOR)
                    .unwrap()
                    .unwrap(),
            };
            store
                .replace_verified_space_repo(&target, commit, &records, RETAINED, OBSERVED)
                .expect("the fixture archive's records hash to its commit");
            let posts = store
                .list_posts_by_boundary(BOUNDARY, None, 50, "2026-09-22T12:00:00.000Z")
                .unwrap()
                .posts
                .into_iter()
                .map(|post| (post.uri, post.cid))
                .collect::<Vec<_>>();
            (
                store.verified_space_base(SPACE, AUTHOR).unwrap(),
                store.interaction_rows(),
                posts,
            )
        };
        let setup = archive_setup(vec![]);
        let archive = read_archive(&setup).await.expect("verified archive");
        let (commit, read) = archive.into_parts();
        assert_eq!(
            read.iter().filter(|record| record.value.is_none()).count(),
            1
        );
        let with_every_value: Vec<VerifiedSpaceRecord> = [
            ("app.bsky.feed.like", "ed", "a like with a strong reference"),
            ("app.bsky.feed.repost", "jet", "a repost"),
            ("app.bsky.graph.follow", "faye", "a follow"),
            ("zone.stratos.feed.post", "swordfish", "a post"),
        ]
        .into_iter()
        .map(|(collection, rkey, name)| {
            let (cid, value) = oracle_record(name);
            VerifiedSpaceRecord {
                path: crate::space_set_hash::RecordPath::parse(collection, rkey).unwrap(),
                cid,
                value: Some(value),
            }
        })
        .collect();

        let without_the_follow = replaced(read, &commit);
        let with_every = replaced(with_every_value, &commit);

        assert_eq!(without_the_follow, with_every);
        assert_eq!(without_the_follow.0.as_ref().unwrap().record_count, 4);
        assert_eq!(without_the_follow.1.len(), 2, "the like and the repost");
        assert_eq!(without_the_follow.2.len(), 1, "the post");
    }

    #[tokio::test]
    async fn an_archive_of_an_empty_repo_is_a_verified_commit_and_no_records() {
        let setup = archive_setup(vec![ArchiveAnswer::SignedBody(fixture_archive("empty"))]);

        let archive = read_archive(&setup).await.expect("verified archive");

        assert!(archive.records().is_empty());
        assert_eq!(archive.commit().repo(), AUTHOR);
    }

    #[tokio::test]
    async fn two_archive_reads_send_two_different_key_shares() {
        let setup = archive_setup(vec![]);
        read_archive(&setup).await.expect("first");
        read_archive(&setup).await.expect("second");
        let shares = setup.host.key_shares();
        assert_eq!(shares.len(), 2);
        assert_ne!(shares[0], shares[1]);
    }

    fn counting<'a>(
        calls: &'a AtomicUsize,
    ) -> impl Fn(&[u8]) -> Result<(Cid, Value), RecordDecodeRefusal> + Sync + 'a {
        move |bytes| {
            calls.fetch_add(1, Ordering::SeqCst);
            decode_record(bytes)
        }
    }

    #[tokio::test]
    async fn metadata_that_differs_from_the_mac_header_is_refused_before_a_record_is_decoded() {
        let calls = AtomicUsize::new(0);
        let setup = archive_setup(vec![ArchiveAnswer::HeaderForRev("3jzfcijpj2z2c")]);

        let error = read_archive_before(&setup, Instant::now() + ROOMY_DEADLINE, &counting(&calls))
            .await
            .err()
            .expect("refused");

        assert_eq!(
            error,
            authentication_failure(MacDefect::CommitDiffersFromSignedHeader)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0, "no record was decoded");
        assert_eq!(setup.host.requests(), 1, "not a stale key");

        let honest = archive_setup(vec![]);
        read_archive_before(&honest, Instant::now() + ROOMY_DEADLINE, &counting(&calls))
            .await
            .expect("honest");
        assert_eq!(calls.load(Ordering::SeqCst), 4, "the counter does count");
    }

    #[tokio::test]
    async fn an_archive_for_another_repo_or_space_is_refused_even_when_its_mac_is_good() {
        let archive = fixture_archive("archive");
        let replaced = |from: &[u8], to: &[u8]| {
            assert_eq!(from.len(), to.len());
            let at = archive
                .windows(from.len())
                .position(|window| window == from)
                .expect("in the metadata");
            assert!(at < 190, "in the metadata, not in a record");
            edited(
                &archive,
                &Edit {
                    at,
                    remove: from.len(),
                    insert: to.to_vec(),
                },
            )
        };
        for other in [
            replaced(b"did:plc:fayevalentine", b"did:plc:jetblack12345"),
            replaced(
                b"zone.stratos.space.feed/crew",
                b"zone.stratos.space.feed/ein0",
            ),
        ] {
            let setup = archive_setup(vec![ArchiveAnswer::SignedBody(other)]);
            let error = read_archive(&setup).await.err().expect("refused");
            assert_eq!(error, authentication_failure(MacDefect::RequestMismatch));
            assert_eq!(setup.host.requests(), 1);
        }
    }

    #[tokio::test]
    async fn a_stale_kem_key_gets_one_refresh_and_one_new_archive_request() {
        let setup = archive_setup(vec![]);
        let rotated = private_key(0x44);
        *setup.host.private_key.lock().unwrap() = rotated.clone();
        setup.resolver.author_kem_key(AUTHOR).await.unwrap();
        setup.directory.publish(public_key(&rotated));

        let archive = read_archive(&setup)
            .await
            .expect("verified after the retry");

        let shares = setup.host.key_shares();
        assert_eq!(shares.len(), 2, "exactly two requests");
        assert_ne!(shares[0], shares[1]);
        assert_eq!(archive.records().len(), 4);
        assert_eq!(setup.directory.fetches(), 2, "one lookup, one refresh");
    }

    #[tokio::test]
    async fn an_archive_whose_mac_fails_twice_fails_after_exactly_two_requests() {
        let setup = archive_setup(vec![]);
        *setup.host.private_key.lock().unwrap() = private_key(0x55);
        setup.resolver.author_kem_key(AUTHOR).await.unwrap();
        setup.directory.publish(public_key(&private_key(0x66)));

        let error = read_archive(&setup).await.err().expect("still wrong");

        assert_eq!(
            error,
            AuthenticatedReadError::Authentication(MacVerifyError::MacMismatch)
        );
        assert_eq!(setup.host.requests(), 2);
    }

    #[tokio::test]
    async fn an_unchanged_key_after_the_refresh_fails_an_archive_without_a_second_request() {
        let setup = archive_setup(vec![]);
        *setup.host.private_key.lock().unwrap() = private_key(0x44);

        let error = read_archive(&setup).await.err().expect("mismatch");

        assert_eq!(
            error,
            AuthenticatedReadError::Authentication(MacVerifyError::MacMismatch)
        );
        assert_eq!(setup.host.requests(), 1);
        assert_eq!(setup.directory.fetches(), 2);
    }

    #[tokio::test]
    async fn a_wrong_content_type_returns_no_records_and_is_not_a_stale_key() {
        for content_type in [
            Some("application/json"),
            Some("application/vnd.dasl.star+json"),
            Some("application/vnd.dasl.stars"),
            None,
        ] {
            let setup = archive_setup(vec![ArchiveAnswer::ContentType(content_type)]);
            let error = read_archive(&setup).await.err().expect("refused");
            assert_eq!(
                error,
                AuthenticatedReadError::Host(SpaceHostError::InvalidResponse),
                "{content_type:?}"
            );
            assert_eq!(setup.host.requests(), 1);
        }
        let setup = archive_setup(vec![ArchiveAnswer::ContentType(Some(
            "Application/Vnd.DASL.Star; q=1",
        ))]);
        assert_eq!(read_archive(&setup).await.unwrap().records().len(), 4);
    }

    // What each edit of the oracle's archive is to the reader. Every one is
    // refused mid-stream, in 97-byte chunks, and returns no record; the one
    // edit it cannot see is a changed value byte, which only the store's digest
    // check catches.
    #[tokio::test]
    async fn every_refused_edit_of_the_fixture_archive_fails_the_read_and_returns_no_records() {
        let archive = fixture_archive("archive");
        let outcomes: Vec<(&str, Option<AuthenticatedReadError>)> = vec![
            (
                "cut before the end marker",
                Some(AuthenticatedReadError::Archive(
                    ArchiveRefusal::UnexpectedEnd,
                )),
            ),
            (
                "cut inside a value",
                Some(AuthenticatedReadError::Archive(
                    ArchiveRefusal::UnexpectedEnd,
                )),
            ),
            (
                "an unknown control byte",
                Some(AuthenticatedReadError::Archive(
                    ArchiveRefusal::UnknownControl,
                )),
            ),
            (
                "one byte after the end",
                Some(AuthenticatedReadError::Archive(
                    ArchiveRefusal::TrailingBytes,
                )),
            ),
            (
                "two records swapped",
                Some(AuthenticatedReadError::ArchiveOrder(
                    RecordOrderRefusal::OutOfOrder,
                )),
            ),
            (
                "a record repeated",
                Some(AuthenticatedReadError::ArchiveOrder(
                    RecordOrderRefusal::OutOfOrder,
                )),
            ),
            (
                "a path that is not collection/rkey",
                Some(AuthenticatedReadError::ArchiveOrder(
                    RecordOrderRefusal::InvalidPath,
                )),
            ),
            ("one value byte changed", None),
            (
                "a non-canonical encoding of the record",
                Some(AuthenticatedReadError::ArchiveRecord(
                    RecordDecodeRefusal::NotCanonical,
                )),
            ),
            (
                "metadata type changed",
                Some(AuthenticatedReadError::Archive(
                    ArchiveRefusal::WrongMetadataType,
                )),
            ),
            (
                "metadata revision changed",
                Some(authentication_failure(
                    MacDefect::CommitDiffersFromSignedHeader,
                )),
            ),
            (
                "a metadata length above the limit",
                Some(AuthenticatedReadError::Archive(
                    ArchiveRefusal::LimitExceeded(ArchiveLimit::Metadata),
                )),
            ),
            (
                "a key length above the limit",
                Some(AuthenticatedReadError::Archive(
                    ArchiveRefusal::LimitExceeded(ArchiveLimit::Key),
                )),
            ),
            (
                "a value length above the limit, no bytes",
                Some(AuthenticatedReadError::Archive(
                    ArchiveRefusal::LimitExceeded(ArchiveLimit::Value),
                )),
            ),
        ];
        let edits = fixture_edits();
        assert_eq!(
            edits.len(),
            outcomes.len(),
            "every fixture row has a verdict here"
        );

        for ((name, edit), (expected_name, expected)) in edits.iter().zip(outcomes) {
            assert_eq!(name, expected_name);
            let setup = archive_setup(vec![ArchiveAnswer::Body(edited(&archive, edit))]);
            let outcome = read_archive(&setup).await;
            match expected {
                Some(error) => assert_eq!(outcome.err(), Some(error), "{name}"),
                None => {
                    let read = outcome.expect("the reader cannot see a changed value");
                    let (original_cid, _) = oracle_record("a post");
                    let post = read.records().last().unwrap();
                    assert_ne!(post.cid, original_cid, "{name}");
                }
            }
            assert_eq!(setup.host.requests(), 1, "{name}: not retried");
        }
    }

    #[tokio::test]
    async fn a_deadline_that_passes_during_the_body_fails_and_returns_no_records() {
        let setup = archive_setup(vec![ArchiveAnswer::StallsAfterFirstChunk]);

        let started = Instant::now();
        let error = read_archive_before(
            &setup,
            Instant::now() + Duration::from_millis(300),
            &decode_record,
        )
        .await
        .err()
        .expect("late");

        assert_eq!(error, AuthenticatedReadError::DeadlineExceeded);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(setup.host.requests(), 1, "no retry after the deadline");
    }

    #[tokio::test]
    async fn a_body_that_breaks_off_fails_with_the_host_error_and_returns_no_records() {
        let setup = archive_setup(vec![ArchiveAnswer::BodyFailsAfterFirstChunk]);
        let error = read_archive(&setup).await.err().expect("broken");
        assert_eq!(
            error,
            AuthenticatedReadError::Host(SpaceHostError::Unreachable)
        );
        assert_eq!(setup.host.requests(), 1);
    }

    #[tokio::test]
    async fn an_archive_deadline_that_has_passed_sends_nothing() {
        let setup = archive_setup(vec![]);
        let error = read_archive_before(&setup, Instant::now(), &decode_record)
            .await
            .err()
            .expect("late");
        assert_eq!(error, AuthenticatedReadError::DeadlineExceeded);
        assert_eq!(setup.host.requests(), 0);
    }

    #[tokio::test]
    async fn an_unavailable_kem_lookup_defers_an_archive_and_sends_nothing() {
        let setup = archive_setup(vec![]);
        setup.directory.list_as(Listing::Unreachable);
        let error = read_archive(&setup).await.err().expect("deferred");
        assert!(error.is_deferred());
        assert_eq!(setup.host.requests(), 0);
    }

    // The error names a host answers with are the caller's to classify; the
    // read adds nothing to them and never retries one.
    #[tokio::test]
    async fn an_error_answer_comes_back_with_its_name_and_is_not_retried() {
        for (status, code) in [
            (400, "RepoNotFound"),
            (400, "RepoTakendown"),
            (400, "RepoSuspended"),
            (400, "RepoDeactivated"),
            (400, "SpaceNotFound"),
            (400, "InvalidSpaceMac"),
            (502, "UpstreamFailure"),
        ] {
            let setup = archive_setup(vec![ArchiveAnswer::Refused { status, code }]);
            let error = read_archive(&setup).await.err().expect("refused");
            assert_eq!(
                error,
                AuthenticatedReadError::Host(SpaceHostError::Request {
                    status,
                    code: Some(code.to_owned()),
                })
            );
            assert_eq!(setup.host.requests(), 1, "{code}");
        }
    }

    // A page body's `commit` member: the MAC verifier is handed it, so a host
    // decides its shape before anything about the page is trusted or counted.
    const NO_TREE_THIS_LARGE: usize = 1024 * 1024;
    const FIXED_EPHEMERAL_KEY: [u8; 32] = [0x44; 32];

    fn page_with_commit(commit: &str) -> Vec<u8> {
        format!("{{\"ops\":[],\"commit\":{commit}}}").into_bytes()
    }

    fn the_five_commit_members() -> String {
        format!(
            "\"ver\":1,\"repo\":\"{AUTHOR}\",\"space\":\"{SPACE}\",\"rev\":\"{REV}\",\"data\":{{\"$bytes\":\"{}\"}}",
            STANDARD.encode(COMMIT_DATA).trim_end_matches('=')
        )
    }

    // Two contexts made from one ephemeral key share one secret, so the same
    // signed headers can be judged twice.
    fn fixed_context() -> MacRequestContext {
        let secret = crate::space_kem::encapsulate_with_ephemeral_key(
            &public_key(&private_key(0x22)),
            &FIXED_EPHEMERAL_KEY,
        )
        .expect("secret");
        MacRequestContext::new(secret, AUTHOR, SPACE)
    }

    fn signed_headers() -> CommitResponseHeaders {
        TestHost::holding(private_key(0x22), vec![]).commit_headers(
            fixed_context().key_share(),
            AUTHOR,
            SPACE,
            REV,
            &STANDARD.encode(COMMIT_DATA),
        )
    }

    fn verdict(
        headers: &CommitResponseHeaders,
        commit: Result<Value, AuthenticatedReadError>,
    ) -> Result<MacVerifiedCommit, AuthenticatedReadError> {
        verify_commit_response(fixed_context(), headers, &commit?)
            .map_err(AuthenticatedReadError::Authentication)
    }

    // How the page read took the commit before it was bounded: the whole
    // member, parsed into a tree.
    fn commit_as_a_whole_tree(body: &[u8]) -> Result<Value, AuthenticatedReadError> {
        #[derive(Deserialize)]
        struct WholeCommit {
            commit: Option<Value>,
        }
        serde_json::from_slice::<WholeCommit>(body)
            .ok()
            .and_then(|member| member.commit)
            .ok_or(AuthenticatedReadError::Host(
                SpaceHostError::InvalidResponse,
            ))
    }

    #[test]
    fn a_hostile_commit_member_is_judged_without_its_tree_being_built() {
        let zeros = format!("[{}0]", "0,".repeat(2_999_999));
        let nested_side_by_side = format!(
            "[{}]",
            vec![format!("{}0{}", "[".repeat(99), "]".repeat(99)); 2_000].join(",")
        );
        let past_the_parsers_depth = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
        let extra_members = format!(
            "{{{},{}}}",
            the_five_commit_members(),
            (0..200_000)
                .map(|at| format!("\"jet{at}\":0"))
                .collect::<Vec<_>>()
                .join(",")
        );
        let malformed = || Err(authentication_failure(MacDefect::MalformedBodyCommit));
        let cases = [
            ("three million zeros", zeros, malformed()),
            (
                "two thousand arrays nested a hundred deep",
                nested_side_by_side,
                malformed(),
            ),
            (
                "nesting past the parser's depth",
                past_the_parsers_depth,
                Err(AuthenticatedReadError::Host(
                    SpaceHostError::InvalidResponse,
                )),
            ),
            (
                "two hundred thousand members beside the five",
                extra_members,
                Ok(MacVerifiedCommit::for_tests(
                    AUTHOR,
                    SPACE,
                    REV,
                    COMMIT_DATA,
                )),
            ),
        ];
        let headers = signed_headers();
        let mut held_per_case = Vec::new();
        for (name, commit, expected) in cases {
            let body = page_with_commit(&commit);
            let (read, held) =
                crate::space_archive::counting::peak_growth_during(|| body_commit(&body));
            held_per_case.push((name, held));
            assert_eq!(verdict(&headers, read), expected, "{name}");
        }
        assert!(
            held_per_case
                .iter()
                .all(|(_, held)| *held < NO_TREE_THIS_LARGE),
            "bytes held: {held_per_case:?}"
        );
    }

    // A seeded mix of the members a commit can carry, each written in shapes
    // the verifier accepts and shapes it refuses, so the bounded read is held
    // to the verdict the whole tree gave on inputs nobody picked by hand.
    #[test]
    fn the_bounded_commit_gets_the_verdict_the_whole_tree_got() {
        let data = STANDARD.encode(COMMIT_DATA);
        let unpadded = data.trim_end_matches('=').to_owned();
        let members: [(&str, Vec<String>); 6] = [
            (
                "ver",
                [
                    "1",
                    "1.0",
                    "\"1\"",
                    "[1]",
                    "{\"v\":1}",
                    "null",
                    "2",
                    "-1",
                    "true",
                    "1e400",
                ]
                .map(str::to_owned)
                .to_vec(),
            ),
            (
                "repo",
                vec![
                    format!("\"{AUTHOR}\""),
                    "5".to_owned(),
                    format!("[\"{AUTHOR}\"]"),
                    "null".to_owned(),
                    "\"did:plc:spikespiegel\"".to_owned(),
                    "\"\\ud800\"".to_owned(),
                ],
            ),
            (
                "space",
                vec![
                    format!("\"{SPACE}\""),
                    format!("\"{OTHER_SPACE}\""),
                    format!("{{\"uri\":\"{SPACE}\"}}"),
                ],
            ),
            (
                "rev",
                vec![
                    format!("\"{REV}\""),
                    "\"not-a-tid\"".to_owned(),
                    "{}".to_owned(),
                ],
            ),
            (
                "data",
                vec![
                    format!("{{\"$bytes\":\"{unpadded}\"}}"),
                    format!("{{\"$bytes\":\"{data}\"}}"),
                    format!("\"{data}\""),
                    format!("{{\"$bytes\":\"{unpadded}\",\"extra\":1}}"),
                    "{\"$bytes\":[1]}".to_owned(),
                    "{}".to_owned(),
                    format!("{{\"$bytes\":\"AAAA\",\"$bytes\":\"{unpadded}\"}}"),
                    format!("{{\"$bytes\":\"{unpadded}\",\"$bytes\":7}}"),
                    format!("{{\"other\":\"{unpadded}\"}}"),
                    format!("{{\"\\u0024bytes\":\"{unpadded}\"}}"),
                ],
            ),
            (
                "note",
                [
                    "\"ignored\"",
                    "[1,{\"a\":null}]",
                    "1e400",
                    "\"\\ud800\"",
                    "{\"ver\":2}",
                ]
                .map(str::to_owned)
                .to_vec(),
            ),
        ];
        let mut generator = 0x5EED_BEB0_u64;
        let mut next = |bound: usize| {
            generator = generator
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (generator >> 33) as usize % bound
        };
        let mut commits = vec![
            format!("{{{}}}", the_five_commit_members()),
            format!("{{{},\"note\":\"ignored\"}}", the_five_commit_members()),
            format!("{{{},\"ver\":2}}", the_five_commit_members()),
            format!("{{\"ver\":2,{}}}", the_five_commit_members()),
            format!(
                "{{{}}}",
                the_five_commit_members().replace("\"ver\"", "\"\\u0076er\"")
            ),
            "[]".to_owned(),
            "null".to_owned(),
            "\"commit\"".to_owned(),
            "7".to_owned(),
        ];
        for _ in 0..500 {
            let mut chosen = Vec::new();
            for (name, shapes) in &members {
                // One of the five is left out one time in five and written
                // twice one time in ten; the extra member is written one time
                // in three. Half the time a member takes its accepted shape.
                let times = match (*name, next(10)) {
                    ("note", _) => usize::from(next(3) == 0),
                    (_, 0 | 1) => 0,
                    (_, 2) => 2,
                    _ => 1,
                };
                for _ in 0..times {
                    let shape = if next(2) == 0 { 0 } else { next(shapes.len()) };
                    chosen.push(format!("\"{name}\":{}", shapes[shape]));
                }
            }
            for at in (1..chosen.len()).rev() {
                chosen.swap(at, next(at + 1));
            }
            commits.push(format!("{{{}}}", chosen.join(",")));
        }
        let headers = signed_headers();
        let mut accepted = 0;
        for commit in &commits {
            let body = page_with_commit(commit);
            let bounded = verdict(&headers, body_commit(&body));
            accepted += usize::from(bounded.is_ok());
            assert_eq!(
                bounded,
                verdict(&headers, commit_as_a_whole_tree(&body)),
                "{commit}"
            );
        }
        for body in [
            b"{\"ops\":[]}".to_vec(),
            format!(
                "{{\"commit\":{{{0}}},\"commit\":{{{0}}}}}",
                the_five_commit_members()
            )
            .into_bytes(),
            b"{\"ops\":[],\"commit\":null}".to_vec(),
        ] {
            assert_eq!(
                verdict(&headers, body_commit(&body)),
                verdict(&headers, commit_as_a_whole_tree(&body)),
                "{}",
                String::from_utf8_lossy(&body)
            );
        }
        assert!(accepted >= 10, "{accepted} commits verified");
    }

    #[tokio::test]
    async fn a_page_body_over_the_poll_limit_is_refused_before_it_is_read() {
        let limit = crate::config::MAX_SPACE_POLL_BODY_BYTES;
        let response = |length: usize| {
            reqwest::Response::from(axum::http::Response::new(reqwest::Body::from(vec![
                b' ';
                length
            ])))
        };

        assert_eq!(
            read_page_body(response(limit + 1))
                .await
                .map(|body| body.len()),
            Err(SpaceHostError::ResponseTooLarge)
        );
        assert_eq!(
            read_page_body(response(limit)).await.map(|body| body.len()),
            Ok(limit)
        );
    }
}

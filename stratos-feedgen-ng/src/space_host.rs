use std::{env, future::Future, net::SocketAddr, sync::Arc, time::Duration};

use async_trait::async_trait;
use reqwest::{Client, redirect::Policy};
use serde::Deserialize;
use serde_json::Value;
use tokio::time::Instant;
use url::Url;

use crate::{
    identifier::Did,
    identity::{PrivateCidr, is_public_address, parse_private_cidrs},
    space_http_signature::SpaceHttpSignatureHeaders,
    space_identity::{AuthorKemKeyResolver, KemKeyLookupError},
    space_kem::{AuthorKemKey, encapsulate},
    space_mac::{
        CommitResponseHeaders, MacRequestContext, MacVerifiedCommit, MacVerifyError,
        verify_commit_response,
    },
    space_sync::{MAX_SPACE_PAGE_OPS, SpacePage, SpaceRepoOp},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 4 * 1024;
const MAX_CURSOR_BYTES: usize = 4 * 1024;
const MAX_REV_BYTES: usize = 512;
const MAX_COLLECTION_BYTES: usize = 317;
const MAX_RKEY_BYTES: usize = 512;
const MAX_CID_BYTES: usize = 256;

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

    pub async fn list_repo_ops(
        &self,
        space_uri: &str,
        actor_did: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<SpaceHostPage, SpaceHostError> {
        let response = self
            .repo_request(space_uri, actor_did, cursor, limit)
            .await?
            .send()
            .await
            .map_err(classify_request_error)?;
        if !response.status().is_success() {
            return Err(request_error(response).await);
        }
        let bytes = response_bytes(response, MAX_PAGE_BYTES).await?;
        decode_page(&bytes)
    }

    async fn repo_request(
        &self,
        space_uri: &str,
        actor_did: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<reqwest::RequestBuilder, SpaceHostError> {
        validate_request(space_uri, actor_did, cursor, limit)?;
        let endpoint = self.endpoint_url("com.atproto.space.listRepoOps")?;
        let mut url = endpoint;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("space", space_uri);
            query.append_pair("repo", actor_did);
            query.append_pair("limit", &limit.to_string());
            if let Some(cursor) = cursor {
                query.append_pair("cursor", cursor);
            }
        }
        let audience = Did::parse(actor_did).map_err(|_| SpaceHostError::InvalidRequest)?;
        let headers = self.proof.presentation_headers(&audience).await?;
        Ok(self
            .client
            .get(url)
            .header("accept", "application/json")
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
    /// with the commit its MAC covers. A stale KEM key is refreshed once and
    /// the whole request is sent again with a new key share; every wait is
    /// bounded by `deadline`.
    pub async fn list_repo_ops_authenticated(
        &self,
        kem_keys: &dyn AuthorKemKeyResolver,
        space_uri: &str,
        actor_did: &str,
        cursor: Option<&str>,
        limit: usize,
        deadline: Instant,
    ) -> Result<AuthenticatedPage, AuthenticatedReadError> {
        let query = RepoOpsQuery {
            space_uri,
            actor_did,
            cursor,
            limit,
        };
        authenticated_read(self, kem_keys, &query, deadline).await
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

/// `KemKeyUnavailable` defers the target; every other variant fails it.
#[derive(Debug, Eq, PartialEq)]
pub enum AuthenticatedReadError {
    KemKeyUnavailable,
    KemKeyInvalid,
    Host(SpaceHostError),
    Authentication(MacVerifyError),
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
            Self::DeadlineExceeded => formatter.write_str("authenticated read ran out of time"),
        }
    }
}

impl std::error::Error for AuthenticatedReadError {}

/// One page request, as it is sent and as the response's commit is bound to it.
pub(crate) struct RepoOpsQuery<'a> {
    space_uri: &'a str,
    actor_did: &'a str,
    cursor: Option<&'a str>,
    limit: usize,
}

/// A success response: its body and the raw lines of the three headers that
/// authenticate it. Nothing outside this module reads the body from it.
#[derive(Clone)]
pub(crate) struct SignedReadResponse {
    body: Vec<u8>,
    headers: CommitResponseHeaders,
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

#[async_trait]
impl RepoOpsTransport for PinnedSpaceHostClient {
    async fn send(
        &self,
        query: &RepoOpsQuery<'_>,
        accept_signature: &str,
    ) -> Result<SignedReadResponse, SpaceHostError> {
        let response = self
            .repo_request(query.space_uri, query.actor_did, query.cursor, query.limit)
            .await?
            .header("accept-signature", accept_signature)
            .send()
            .await
            .map_err(classify_request_error)?;
        if !response.status().is_success() {
            return Err(request_error(response).await);
        }
        let headers = CommitResponseHeaders {
            commit: header_lines(&response, "atproto-space-commit"),
            signature_input: header_lines(&response, "signature-input"),
            signature: header_lines(&response, "signature"),
        };
        let body = response_bytes(response, MAX_PAGE_BYTES).await?;
        Ok(SignedReadResponse { body, headers })
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

async fn authenticated_read(
    transport: &dyn RepoOpsTransport,
    kem_keys: &dyn AuthorKemKeyResolver,
    query: &RepoOpsQuery<'_>,
    deadline: Instant,
) -> Result<AuthenticatedPage, AuthenticatedReadError> {
    let first_key = before(deadline, kem_keys.author_kem_key(query.actor_did))
        .await?
        .map_err(kem_lookup_failure)?;
    match attempt(transport, &first_key, query, deadline).await {
        Err(AuthenticatedReadError::Authentication(MacVerifyError::MacMismatch)) => {}
        outcome => return outcome,
    }
    let refreshed_key = before(deadline, kem_keys.refreshed_author_kem_key(query.actor_did))
        .await?
        .map_err(kem_lookup_failure)?;
    if refreshed_key == first_key {
        return Err(AuthenticatedReadError::Authentication(
            MacVerifyError::MacMismatch,
        ));
    }
    attempt(transport, &refreshed_key, query, deadline).await
}

// Each attempt makes its own ephemeral key and consumes its own context.
async fn attempt(
    transport: &dyn RepoOpsTransport,
    kem_key: &AuthorKemKey,
    query: &RepoOpsQuery<'_>,
    deadline: Instant,
) -> Result<AuthenticatedPage, AuthenticatedReadError> {
    let secret = encapsulate(kem_key).map_err(|_| AuthenticatedReadError::KemKeyInvalid)?;
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

fn body_commit(body: &[u8]) -> Result<Value, AuthenticatedReadError> {
    #[derive(Deserialize)]
    struct CommitMember {
        commit: Option<Value>,
    }
    serde_json::from_slice::<CommitMember>(body)
        .ok()
        .and_then(|member| member.commit)
        .ok_or(AuthenticatedReadError::Host(
            SpaceHostError::InvalidResponse,
        ))
}

pub struct SpaceHostPage {
    pub page: SpacePage,
    pub commit: Option<SpaceCommit>,
}

pub struct SpaceCommit {
    raw: Value,
}

impl SpaceCommit {
    #[cfg(test)]
    pub(crate) fn from_value(raw: Value) -> Self {
        Self { raw }
    }

    pub fn as_value(&self) -> &Value {
        &self.raw
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
    if space_uri.is_empty()
        || space_uri.len() > 2_048
        || actor_did.is_empty()
        || actor_did.len() > 2_048
        || cursor.is_some_and(|value| value.is_empty() || value.len() > MAX_CURSOR_BYTES)
        || limit == 0
        || limit > MAX_SPACE_PAGE_OPS
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

fn decode_page(bytes: &[u8]) -> Result<SpaceHostPage, SpaceHostError> {
    let response: RawPage =
        serde_json::from_slice(bytes).map_err(|_| SpaceHostError::InvalidResponse)?;
    if response.ops.len() > MAX_SPACE_PAGE_OPS
        || response
            .cursor
            .as_deref()
            .is_some_and(|cursor| cursor.is_empty() || cursor.len() > MAX_CURSOR_BYTES)
    {
        return Err(SpaceHostError::InvalidResponse);
    }
    let mut ops = Vec::with_capacity(response.ops.len());
    for op in response.ops {
        if op.rev.is_empty()
            || op.rev.len() > MAX_REV_BYTES
            || op.collection.is_empty()
            || op.rkey.is_empty()
            || op.collection.len() > MAX_COLLECTION_BYTES
            || op.rkey.len() > MAX_RKEY_BYTES
            || op.cid.as_ref().is_some_and(|cid| cid.len() > MAX_CID_BYTES)
        {
            return Err(SpaceHostError::InvalidResponse);
        }
        ops.push(SpaceRepoOp {
            collection: op.collection,
            rkey: op.rkey,
            cid: op.cid,
            value: op.value,
        });
    }
    if response
        .commit
        .as_ref()
        .is_some_and(|commit| !commit.is_object())
    {
        return Err(SpaceHostError::InvalidResponse);
    }
    Ok(SpaceHostPage {
        page: SpacePage {
            ops,
            next_cursor: response.cursor,
        },
        commit: response.commit.map(|raw| SpaceCommit { raw }),
    })
}

#[derive(Deserialize)]
struct RawPage {
    ops: Vec<RawOp>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    commit: Option<Value>,
}

#[derive(Deserialize)]
struct RawOp {
    rev: String,
    collection: String,
    rkey: String,
    cid: Option<String>,
    #[serde(default)]
    value: Option<Value>,
}

#[cfg(test)]
mod tests {
    use std::{
        net::{Ipv4Addr, SocketAddr},
        sync::Arc,
    };

    use async_trait::async_trait;

    use super::{
        HostResolver, PinnedSpaceHostClient, PrivateHostPolicy, SpaceCredentialProof,
        SpaceHostError, decode_page, parse_origin, validate_addresses, validate_request,
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
    fn rejects_malformed_or_unbounded_pages() {
        for body in [
            br#"{}"#.as_slice(),
            br#"{"ops":[{}]}"#.as_slice(),
            br#"{"ops":[{"rev":"r","collection":"zone.stratos.feed.post","rkey":"k","cid":3}]}"#
                .as_slice(),
            br#"{"ops":[],"commit":false}"#.as_slice(),
        ] {
            assert!(matches!(
                decode_page(body),
                Err(SpaceHostError::InvalidResponse)
            ));
        }
    }

    #[test]
    fn distinguishes_invalid_request_inputs_from_host_responses() {
        assert_eq!(
            validate_request("", "did:plc:member", None, 1),
            Err(SpaceHostError::InvalidRequest)
        );
    }

    #[test]
    fn decodes_a_bounded_repo_page() {
        let page = decode_page(br#"{"ops":[{"rev":"r","collection":"zone.stratos.feed.post","rkey":"k","cid":null}],"cursor":"next","commit":{"rev":"r"}}"#).unwrap();
        assert_eq!(page.page.ops.len(), 1);
        assert_eq!(page.page.next_cursor.as_deref(), Some("next"));
        assert!(page.commit.is_some());
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
            .repo_request(space, "did:plc:rei", None, 10)
            .await
            .unwrap()
            .build()
            .unwrap();
        let repeat = client
            .repo_request(space, "did:plc:rei", Some("next"), 20)
            .await
            .unwrap()
            .build()
            .unwrap();
        let misato = client
            .repo_request(space, "did:plc:misato", None, 10)
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
                .repo_request(space, "https://pds.example.test", None, 10)
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
            .repo_request(&space, "did:plc:rei", None, 10)
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
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use base64::{Engine, engine::general_purpose::STANDARD};
    use hmac::{Hmac, Mac};
    use p256::{SecretKey, elliptic_curve::sec1::ToEncodedPoint};
    use serde_json::json;
    use sha2::Sha256;
    use tokio::time::Instant;

    use super::*;
    use crate::{
        auth::IdentityResolutionError,
        identity::{DidDocumentSource, HttpIdentityKeyResolver},
        space_identity::AuthorKemKeyResolver,
        space_kem::{AuthorKemKey, decapsulate},
        space_mac::{MacDefect, MacVerifyError},
        space_signature_fields::{members_with_tag, parse_dictionary},
    };

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
        AuthorKemKey::from_sec1_bytes(private.public_key().to_encoded_point(false).as_bytes())
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
        key_shares: Mutex<Vec<String>>,
        first_response: Mutex<Option<SignedReadResponse>>,
    }

    impl TestHost {
        fn holding(private_key: SecretKey, script: Vec<Answer>) -> Arc<Self> {
            Arc::new(Self {
                private_key: Mutex::new(private_key),
                script: Mutex::new(script.into()),
                key_shares: Mutex::new(Vec::new()),
                first_response: Mutex::new(None),
            })
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
            let secret = decapsulate(&self.private_key.lock().unwrap(), key_share).unwrap();
            let commit_header = format!(
                "ver=1, repo=\"{repo}\", space=\"{space}\", rev=\"{REV}\", data=:{data_text}:"
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
                headers: CommitResponseHeaders {
                    commit: vec![commit_header],
                    signature_input: vec![format!("mac={params}")],
                    signature: vec![format!(
                        "mac=:{}:",
                        STANDARD.encode(mac.finalize().into_bytes())
                    )],
                },
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
}

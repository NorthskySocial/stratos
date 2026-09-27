use std::{env, net::SocketAddr, sync::Arc, time::Duration};

use async_trait::async_trait;
use reqwest::{Client, redirect::Policy};
use serde::Deserialize;
use serde_json::Value;
use url::Url;

use crate::{
    identity::{PrivateCidr, is_public_address, parse_private_cidrs},
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
    fn credential(&self) -> &str;

    async fn presentation_proof(
        &self,
        method: &str,
        target_uri: &str,
    ) -> Result<String, SpaceHostError>;
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
        validate_request(space_uri, actor_did, cursor, limit)?;
        let endpoint = self.endpoint_url("com.atproto.space.listRepoOps")?;
        let target_uri = endpoint.to_string();
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
        let dpop = self.proof.presentation_proof("GET", &target_uri).await?;
        let response = self
            .client
            .get(url)
            .header("accept", "application/json")
            .header("authorization", format!("DPoP {}", self.proof.credential()))
            .header("dpop", dpop)
            .send()
            .await
            .map_err(classify_request_error)?;
        if !response.status().is_success() {
            return Err(request_error(response).await);
        }
        let bytes = response_bytes(response, MAX_PAGE_BYTES).await?;
        decode_page(&bytes)
    }

    fn endpoint_url(&self, lxm: &str) -> Result<Url, SpaceHostError> {
        self.origin
            .join(&format!("xrpc/{lxm}"))
            .map_err(|_| SpaceHostError::InvalidOrigin)
    }
}

pub struct SpaceHostPage {
    pub page: SpacePage,
    pub commit: Option<SpaceCommit>,
}

pub struct SpaceCommit {
    raw: Value,
}

impl SpaceCommit {
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
        fn credential(&self) -> &str {
            "credential"
        }

        async fn presentation_proof(&self, _: &str, _: &str) -> Result<String, SpaceHostError> {
            Ok("proof".to_owned())
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
}

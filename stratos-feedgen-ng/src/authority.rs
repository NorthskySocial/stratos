use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, StatusCode, redirect::Policy};
use serde::Deserialize;
use url::Url;

use crate::{
    identifier::Did,
    moderation_label::{LabelPage, parse_label_page},
    service_auth::{ServiceAuthError, ServiceSigningKey, mint_service_jwt},
};

const RESOLVE_ENROLLMENTS_LXM: &str = "zone.stratos.identity.resolveEnrollments";
const QUERY_LABELS_LXM: &str = "zone.stratos.moderation.queryLabels";
const LABEL_PAGE_LIMIT: u16 = 100;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE_BYTES: usize = 32 * 1024;
const MAX_LABEL_PAGE_BYTES: usize = 512 * 1024;
const MAX_BOUNDARIES: usize = 128;
const MAX_BOUNDARY_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnrollmentResolution {
    pub did: String,
    pub enrolled: bool,
    pub boundaries: Vec<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum AuthorityError {
    InvalidConfiguration,
    InvalidRequest,
    Authentication,
    Unavailable,
    ResponseTooLarge,
    InvalidResponse,
}

impl std::fmt::Display for AuthorityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("authority enrollment resolution failed")
    }
}

impl std::error::Error for AuthorityError {}

#[async_trait]
pub trait AuthorityClient: Send + Sync {
    async fn resolve_enrollment(
        &self,
        did: &str,
        now: u64,
    ) -> Result<EnrollmentResolution, AuthorityError>;
}

#[async_trait]
pub trait LabelLogClient: Send + Sync {
    async fn query_labels(&self, cursor: u64, now: u64) -> Result<LabelPage, AuthorityError>;
}

pub struct HttpAuthorityClient {
    client: Client,
    service_url: Url,
    service_did: String,
    feedgen_did: String,
    signing_key: ServiceSigningKey,
}

impl HttpAuthorityClient {
    pub fn new(
        service_url: &str,
        service_did: impl Into<String>,
        feedgen_did: impl Into<String>,
        signing_key: ServiceSigningKey,
    ) -> Result<Self, AuthorityError> {
        let service_url =
            Url::parse(service_url).map_err(|_| AuthorityError::InvalidConfiguration)?;
        if !matches!(service_url.scheme(), "http" | "https")
            || service_url.host_str().is_none()
            || !service_url.username().is_empty()
            || service_url.password().is_some()
            || service_url.query().is_some()
            || service_url.fragment().is_some()
        {
            return Err(AuthorityError::InvalidConfiguration);
        }
        let service_did = service_did.into();
        let feedgen_did = feedgen_did.into();
        Did::parse(service_did.clone()).map_err(|_| AuthorityError::InvalidConfiguration)?;
        Did::parse(feedgen_did.clone()).map_err(|_| AuthorityError::InvalidConfiguration)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(REQUEST_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| AuthorityError::InvalidConfiguration)?;
        Ok(Self {
            client,
            service_url,
            service_did,
            feedgen_did,
            signing_key,
        })
    }

    fn resolve_url(&self, did: &str) -> Result<Url, AuthorityError> {
        Did::parse(did.to_owned()).map_err(|_| AuthorityError::InvalidRequest)?;
        let mut url = self.service_url.clone();
        let base_path = url.path().trim_end_matches('/');
        url.set_path(&format!("{base_path}/xrpc/{RESOLVE_ENROLLMENTS_LXM}"));
        url.query_pairs_mut().append_pair("did", did);
        Ok(url)
    }

    fn query_labels_url(&self, cursor: u64) -> Url {
        let mut url = self.service_url.clone();
        let base_path = url.path().trim_end_matches('/');
        url.set_path(&format!("{base_path}/xrpc/{QUERY_LABELS_LXM}"));
        {
            let mut query = url.query_pairs_mut();
            if cursor != 0 {
                query.append_pair("cursor", &cursor.to_string());
            }
            query.append_pair("limit", &LABEL_PAGE_LIMIT.to_string());
        }
        url
    }

    async fn response_bytes(
        &self,
        mut response: reqwest::Response,
        max_bytes: usize,
    ) -> Result<Vec<u8>, AuthorityError> {
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(AuthorityError::ResponseTooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AuthorityError::Unavailable)?
        {
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                return Err(AuthorityError::ResponseTooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

#[async_trait]
impl AuthorityClient for HttpAuthorityClient {
    async fn resolve_enrollment(
        &self,
        did: &str,
        now: u64,
    ) -> Result<EnrollmentResolution, AuthorityError> {
        let url = self.resolve_url(did)?;
        let token = mint_service_jwt(
            &self.signing_key,
            &self.feedgen_did,
            &self.service_did,
            RESOLVE_ENROLLMENTS_LXM,
            now,
        )
        .map_err(map_service_auth_error)?;
        let response = self
            .client
            .get(url)
            .header("authorization", format!("Bearer {token}"))
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|_| AuthorityError::Unavailable)?;
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            return Err(AuthorityError::Authentication);
        }
        if !response.status().is_success() {
            return Err(AuthorityError::Unavailable);
        }
        parse_resolution(
            did,
            &self.service_did,
            &self.response_bytes(response, MAX_RESPONSE_BYTES).await?,
        )
    }
}

#[async_trait]
impl LabelLogClient for HttpAuthorityClient {
    async fn query_labels(&self, cursor: u64, now: u64) -> Result<LabelPage, AuthorityError> {
        let token = mint_service_jwt(
            &self.signing_key,
            &self.feedgen_did,
            &self.service_did,
            QUERY_LABELS_LXM,
            now,
        )
        .map_err(map_service_auth_error)?;
        let response = self
            .client
            .get(self.query_labels_url(cursor))
            .header("authorization", format!("Bearer {token}"))
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|_| AuthorityError::Unavailable)?;
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            return Err(AuthorityError::Authentication);
        }
        if !response.status().is_success() {
            return Err(AuthorityError::Unavailable);
        }
        let body = self.response_bytes(response, MAX_LABEL_PAGE_BYTES).await?;
        parse_label_page(&body, cursor, LABEL_PAGE_LIMIT)
            .map_err(|_| AuthorityError::InvalidResponse)
    }
}

fn map_service_auth_error(error: ServiceAuthError) -> AuthorityError {
    match error {
        ServiceAuthError::InvalidSigningKey
        | ServiceAuthError::InvalidDelegationClaims
        | ServiceAuthError::Serialization => AuthorityError::InvalidConfiguration,
    }
}

fn parse_resolution(
    expected_did: &str,
    service_did: &str,
    bytes: &[u8],
) -> Result<EnrollmentResolution, AuthorityError> {
    let response: RawResolution =
        serde_json::from_slice(bytes).map_err(|_| AuthorityError::InvalidResponse)?;
    if response.did != expected_did {
        return Err(AuthorityError::InvalidResponse);
    }
    Did::parse(response.did.clone()).map_err(|_| AuthorityError::InvalidResponse)?;
    if !response.enrolled {
        if response
            .boundaries
            .is_some_and(|boundaries| !boundaries.is_empty())
        {
            return Err(AuthorityError::InvalidResponse);
        }
        return Ok(EnrollmentResolution {
            did: response.did,
            enrolled: false,
            boundaries: Vec::new(),
        });
    }
    let boundaries = response.boundaries.ok_or(AuthorityError::InvalidResponse)?;
    if boundaries.len() > MAX_BOUNDARIES
        || boundaries.iter().any(|boundary| {
            boundary.is_empty() || boundary.len() > MAX_BOUNDARY_BYTES || !boundary.is_ascii()
        })
    {
        return Err(AuthorityError::InvalidResponse);
    }
    let mut unique = std::collections::BTreeSet::new();
    for boundary in boundaries {
        if let Some(boundary) = normalize_boundary(service_did, &boundary) {
            unique.insert(boundary);
        }
    }
    Ok(EnrollmentResolution {
        did: response.did,
        enrolled: true,
        boundaries: unique.into_iter().collect(),
    })
}

pub(crate) fn normalize_boundary(service_did: &str, boundary: &str) -> Option<String> {
    if boundary.starts_with("did:") && boundary.contains('/') {
        let (boundary_service_did, name) = boundary.split_once('/')?;
        if boundary_service_did != service_did || name.is_empty() {
            return None;
        }
        Did::parse(boundary_service_did.to_owned()).ok()?;
        return Some(boundary.to_owned());
    }
    Some(format!("{service_did}/{boundary}"))
}

#[derive(Deserialize)]
struct RawResolution {
    did: String,
    enrolled: bool,
    boundaries: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::{
        AuthorityError, HttpAuthorityClient, LabelLogClient, MAX_LABEL_PAGE_BYTES,
        QUERY_LABELS_LXM, parse_resolution,
    };
    use crate::service_auth::ServiceSigningKey;

    const TAKEDOWN_URI: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/bebop1";

    fn label_client(address: std::net::SocketAddr) -> HttpAuthorityClient {
        HttpAuthorityClient::new(
            &format!("http://{address}"),
            "did:web:stratos.example.test",
            "did:web:feedgen.example.test",
            ServiceSigningKey::from_hex(&"11".repeat(32)).unwrap(),
        )
        .unwrap()
    }

    async fn respond_once(
        response: Vec<u8>,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let Ok(Ok((mut stream, _))) =
                tokio::time::timeout(std::time::Duration::from_secs(2), listener.accept()).await
            else {
                return String::new();
            };
            let mut bytes = Vec::new();
            while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                let mut chunk = [0; 4096];
                let read = stream.read(&mut chunk).await.unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
            }
            let _ = stream.write_all(&response).await;
            let _ = stream.shutdown().await;
            String::from_utf8(bytes).unwrap()
        });
        (address, server)
    }

    fn http_response(status: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    #[test]
    fn parses_only_a_bounded_exact_authority_response() {
        let resolution = parse_resolution(
            "did:plc:faye",
            "did:web:stratos.example.test",
            br#"{"did":"did:plc:faye","enrolled":true,"boundaries":["bebop","crew","did:web:other.example.test/other"]}"#,
        )
        .unwrap();
        assert_eq!(
            resolution.boundaries,
            [
                "did:web:stratos.example.test/bebop",
                "did:web:stratos.example.test/crew"
            ]
        );
        assert!(
            parse_resolution(
                "did:plc:faye",
                "did:web:stratos.example.test",
                br#"{"did":"did:plc:ed","enrolled":true,"boundaries":["bebop"]}"#
            )
            .is_err()
        );
        assert!(
            parse_resolution(
                "did:plc:faye",
                "did:web:stratos.example.test",
                br#"{"did":"did:plc:faye","enrolled":false,"boundaries":["bebop"]}"#
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_unsafe_authority_urls_and_invalid_request_dids() {
        let key = ServiceSigningKey::from_hex(&"11".repeat(32)).unwrap();
        assert!(matches!(
            HttpAuthorityClient::new(
                "file:///tmp/authority",
                "did:web:stratos.example.test",
                "did:web:feedgen.example.test",
                key.clone(),
            ),
            Err(AuthorityError::InvalidConfiguration)
        ));
        let client = HttpAuthorityClient::new(
            "https://stratos.example.test/base",
            "did:web:stratos.example.test",
            "did:web:feedgen.example.test",
            key,
        )
        .unwrap();
        assert_eq!(
            client.resolve_url("not-a-did").unwrap_err(),
            AuthorityError::InvalidRequest
        );
        assert_eq!(
            client.resolve_url("did:plc:faye").unwrap().as_str(),
            "https://stratos.example.test/base/xrpc/zone.stratos.identity.resolveEnrollments?did=did%3Aplc%3Afaye"
        );
    }

    #[tokio::test]
    async fn queries_labels_with_an_exact_request_and_method_bound_token() {
        let body = format!(
            r##"{{"cursor":"8","labels":[{{"seq":8,"subject":{{"$type":"zone.stratos.moderation.defs#recordSubject","uri":"{TAKEDOWN_URI}"}},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}}]}}"##
        );
        let (address, server) = respond_once(http_response("200 OK", body.as_bytes())).await;
        let page = label_client(address).query_labels(7, 1_000).await.unwrap();
        assert_eq!(page.cursor, 8);
        assert_eq!(page.labels.len(), 1);
        let head = server.await.unwrap();
        assert!(head.starts_with(
            "GET /xrpc/zone.stratos.moderation.queryLabels?cursor=7&limit=100 HTTP/1.1\r\n"
        ));
        let authorization = head
            .lines()
            .find_map(|line| line.strip_prefix("authorization: Bearer "))
            .unwrap();
        let claims_segment = authorization.split('.').nth(1).unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims_segment).unwrap()).unwrap();
        assert_eq!(claims["lxm"], QUERY_LABELS_LXM);
        assert_eq!(claims["aud"], "did:web:stratos.example.test");
    }

    #[tokio::test]
    async fn omits_the_cursor_parameter_at_zero() {
        let (address, server) =
            respond_once(http_response("200 OK", br#"{"cursor":"0","labels":[]}"#)).await;
        label_client(address).query_labels(0, 1_000).await.unwrap();
        let head = server.await.unwrap();
        assert!(
            head.starts_with(
                "GET /xrpc/zone.stratos.moderation.queryLabels?limit=100 HTTP/1.1\r\n"
            )
        );
    }

    #[tokio::test]
    async fn rejects_oversized_label_bodies_declared_or_chunked() {
        let oversized = vec![b' '; MAX_LABEL_PAGE_BYTES + 1];
        let (address, server) = respond_once(http_response("200 OK", &oversized)).await;
        assert_eq!(
            label_client(address).query_labels(0, 1_000).await,
            Err(AuthorityError::ResponseTooLarge)
        );
        server.await.unwrap();

        let mut chunked =
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n".to_vec();
        chunked.extend_from_slice(format!("{:x}\r\n", oversized.len()).as_bytes());
        chunked.extend_from_slice(&oversized);
        chunked.extend_from_slice(b"\r\n0\r\n\r\n");
        let (address, server) = respond_once(chunked).await;
        assert_eq!(
            label_client(address).query_labels(0, 1_000).await,
            Err(AuthorityError::ResponseTooLarge)
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn maps_label_statuses_and_malformed_pages() {
        for (status, expected) in [
            ("401 Unauthorized", AuthorityError::Authentication),
            ("403 Forbidden", AuthorityError::Authentication),
            ("500 Internal Server Error", AuthorityError::Unavailable),
        ] {
            let (address, server) = respond_once(http_response(status, b"{}")).await;
            assert_eq!(
                label_client(address).query_labels(0, 1_000).await,
                Err(expected)
            );
            server.await.unwrap();
        }
        let (address, server) = respond_once(http_response("200 OK", b"{")).await;
        assert_eq!(
            label_client(address).query_labels(0, 1_000).await,
            Err(AuthorityError::InvalidResponse)
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn label_errors_never_echo_the_subject() {
        let body = format!(
            r##"{{"cursor":"1","labels":[{{"seq":9,"subject":{{"$type":"zone.stratos.moderation.defs#recordSubject","uri":"{TAKEDOWN_URI}"}},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}}]}}"##
        );
        let (address, server) = respond_once(http_response("200 OK", body.as_bytes())).await;
        let error = label_client(address)
            .query_labels(0, 1_000)
            .await
            .unwrap_err();
        server.await.unwrap();
        for text in [error.to_string(), format!("{error:?}")] {
            assert!(!text.contains("spikespiegel"));
        }
    }
}

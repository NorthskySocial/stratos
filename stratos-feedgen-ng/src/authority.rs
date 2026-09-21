use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, StatusCode, redirect::Policy};
use serde::Deserialize;
use url::Url;

use crate::{
    identifier::Did,
    service_auth::{ServiceAuthError, ServiceSigningKey, mint_service_jwt},
};

const RESOLVE_ENROLLMENTS_LXM: &str = "zone.stratos.identity.resolveEnrollments";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE_BYTES: usize = 32 * 1024;
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

    async fn response_bytes(
        &self,
        mut response: reqwest::Response,
    ) -> Result<Vec<u8>, AuthorityError> {
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(AuthorityError::ResponseTooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AuthorityError::Unavailable)?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
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
            &self.response_bytes(response).await?,
        )
    }
}

fn map_service_auth_error(error: ServiceAuthError) -> AuthorityError {
    match error {
        ServiceAuthError::InvalidSigningKey | ServiceAuthError::Serialization => {
            AuthorityError::InvalidConfiguration
        }
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
    use super::{AuthorityError, HttpAuthorityClient, parse_resolution};
    use crate::service_auth::ServiceSigningKey;

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
}

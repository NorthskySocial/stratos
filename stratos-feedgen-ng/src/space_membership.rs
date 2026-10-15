use std::time::Duration;

use reqwest::{Client, StatusCode, redirect::Policy};
use serde::Deserialize;
use url::Url;

use crate::{
    identifier::Did, space_credential::HeldSpaceCredential, space_host::SpaceCredentialProof,
};

const LIST_REPOS_LXM: &str = "zone.stratos.space.listRepos";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
pub const MAX_MEMBERSHIP_RESPONSE_MEMBERS: usize = 1_000;
const MAX_CURSOR_BYTES: usize = 4 * 1024;
const MAX_HOST_BYTES: usize = 2_048;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RepoCustody {
    Pds,
    Stratos,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpaceRepoMember {
    pub did: String,
    pub custody: RepoCustody,
    pub host: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpaceMembershipPage {
    pub members: Vec<SpaceRepoMember>,
    pub next_cursor: Option<String>,
}

#[async_trait::async_trait]
pub trait SpaceMembershipClient: Send + Sync {
    async fn list(
        &self,
        space_uri: &str,
        credential: &HeldSpaceCredential,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<SpaceMembershipPage, SpaceMembershipError>;
}

#[derive(Debug, Eq, PartialEq)]
pub enum SpaceMembershipError {
    InvalidConfiguration,
    InvalidRequest,
    Authentication,
    Unavailable,
    ResponseTooLarge,
    InvalidResponse,
    Proof,
}

impl std::fmt::Display for SpaceMembershipError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("space membership enumeration failed")
    }
}

impl std::error::Error for SpaceMembershipError {}

pub struct HttpSpaceMembershipClient {
    client: Client,
    service_url: Url,
}

impl HttpSpaceMembershipClient {
    pub fn new(service_url: &str, public_url: &str) -> Result<Self, SpaceMembershipError> {
        let service_url = validate_base_url(service_url)?;
        validate_base_url(public_url)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(REQUEST_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| SpaceMembershipError::InvalidConfiguration)?;
        Ok(Self {
            client,
            service_url,
        })
    }

    pub async fn list(
        &self,
        space_uri: &str,
        credential: &dyn SpaceCredentialProof,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<SpaceMembershipPage, SpaceMembershipError> {
        validate_request(space_uri, cursor, limit)?;
        let mut request_url = endpoint(&self.service_url);
        {
            let mut query = request_url.query_pairs_mut();
            query.append_pair("space", space_uri);
            query.append_pair("limit", &limit.to_string());
            if let Some(cursor) = cursor {
                query.append_pair("cursor", cursor);
            }
        }
        let authority = space_authority(space_uri)?;
        let headers = credential
            .presentation_headers(&authority)
            .await
            .map_err(|_| SpaceMembershipError::Proof)?;
        let response = self
            .client
            .get(request_url)
            .header("accept", "application/json")
            .header("authorization", headers.authorization())
            .header("atproto-space-audience", authority.as_str())
            .header("signature-input", headers.signature_input())
            .header("signature", headers.signature())
            .send()
            .await
            .map_err(classify_request_error)?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(SpaceMembershipError::Authentication);
        }
        if !response.status().is_success() {
            return Err(SpaceMembershipError::Unavailable);
        }
        decode_page(&response_bytes(response).await?)
    }
}

#[async_trait::async_trait]
impl SpaceMembershipClient for HttpSpaceMembershipClient {
    async fn list(
        &self,
        space_uri: &str,
        credential: &HeldSpaceCredential,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<SpaceMembershipPage, SpaceMembershipError> {
        HttpSpaceMembershipClient::list(self, space_uri, credential, cursor, limit).await
    }
}

fn validate_base_url(value: &str) -> Result<Url, SpaceMembershipError> {
    let url = Url::parse(value).map_err(|_| SpaceMembershipError::InvalidConfiguration)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(SpaceMembershipError::InvalidConfiguration);
    }
    Ok(url)
}

fn endpoint(base: &Url) -> Url {
    let mut endpoint = base.clone();
    let base_path = endpoint.path().trim_end_matches('/');
    endpoint.set_path(&format!("{base_path}/xrpc/{LIST_REPOS_LXM}"));
    endpoint.set_query(None);
    endpoint
}

fn space_authority(space_uri: &str) -> Result<Did, SpaceMembershipError> {
    let parts: Vec<_> = space_uri
        .strip_prefix("at://")
        .ok_or(SpaceMembershipError::InvalidRequest)?
        .split('/')
        .collect();
    let [authority, "space", "zone.stratos.space.feed", key] = parts.as_slice() else {
        return Err(SpaceMembershipError::InvalidRequest);
    };
    let did = Did::parse(*authority).map_err(|_| SpaceMembershipError::InvalidRequest)?;
    if crate::credential_manager::boundary_to_space_uri(&format!("{authority}/{key}"))
        .map_err(|_| SpaceMembershipError::InvalidRequest)?
        != space_uri
    {
        return Err(SpaceMembershipError::InvalidRequest);
    }
    Ok(did)
}

fn validate_request(
    space_uri: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<(), SpaceMembershipError> {
    if space_uri.is_empty()
        || space_uri.len() > 2_048
        || cursor.is_some_and(|cursor| cursor.is_empty() || cursor.len() > MAX_CURSOR_BYTES)
        || limit == 0
        || limit > MAX_MEMBERSHIP_RESPONSE_MEMBERS
    {
        return Err(SpaceMembershipError::InvalidRequest);
    }
    Ok(())
}

fn classify_request_error(_: reqwest::Error) -> SpaceMembershipError {
    SpaceMembershipError::Unavailable
}

async fn response_bytes(mut response: reqwest::Response) -> Result<Vec<u8>, SpaceMembershipError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(SpaceMembershipError::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(classify_request_error)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(SpaceMembershipError::ResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn decode_page(bytes: &[u8]) -> Result<SpaceMembershipPage, SpaceMembershipError> {
    let response: ListReposResponse =
        serde_json::from_slice(bytes).map_err(|_| SpaceMembershipError::InvalidResponse)?;
    if response.repos.len() > MAX_MEMBERSHIP_RESPONSE_MEMBERS
        || response
            .cursor
            .as_deref()
            .is_some_and(|cursor| cursor.is_empty() || cursor.len() > MAX_CURSOR_BYTES)
    {
        return Err(SpaceMembershipError::InvalidResponse);
    }
    let mut members = Vec::with_capacity(response.repos.len());
    for repo in response.repos {
        Did::parse(repo.did.clone()).map_err(|_| SpaceMembershipError::InvalidResponse)?;
        let host = (repo.custody == RepoCustody::Pds)
            .then(|| repo.host.filter(|host| is_valid_pds_origin(host)))
            .flatten();
        members.push(SpaceRepoMember {
            did: repo.did,
            custody: repo.custody,
            host,
        });
    }
    Ok(SpaceMembershipPage {
        members,
        next_cursor: response.cursor,
    })
}

fn is_valid_pds_origin(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_HOST_BYTES {
        return false;
    }
    let Ok(origin) = Url::parse(value) else {
        return false;
    };
    origin.scheme() == "https"
        && origin.host_str().is_some()
        && origin.username().is_empty()
        && origin.password().is_none()
        && origin.query().is_none()
        && origin.fragment().is_none()
        && origin.path() == "/"
}

#[derive(Deserialize)]
struct ListReposResponse {
    repos: Vec<ListRepoResponse>,
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Deserialize)]
struct ListRepoResponse {
    did: String,
    custody: RepoCustody,
    #[serde(default)]
    host: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        HttpSpaceMembershipClient, RepoCustody, SpaceMembershipError, decode_page, endpoint,
        validate_request,
    };

    #[test]
    fn decodes_explicit_pds_custody_and_rejects_unknown_custody() {
        let page = decode_page(
            br#"{"repos":[{"did":"did:plc:member","custody":"pds","host":"https://pds.example.test/"},{"did":"did:web:stratos.example.test","custody":"stratos"}],"cursor":"next"}"#,
        )
        .unwrap();
        assert_eq!(page.members[0].custody, RepoCustody::Pds);
        assert_eq!(
            page.members[0].host.as_deref(),
            Some("https://pds.example.test/")
        );
        assert_eq!(page.members[1].custody, RepoCustody::Stratos);
        assert_eq!(page.next_cursor.as_deref(), Some("next"));
        assert_eq!(
            decode_page(br#"{"repos":[{"did":"did:plc:member","custody":"unknown"}]}"#),
            Err(SpaceMembershipError::InvalidResponse)
        );
    }

    #[test]
    fn rejects_untrusted_or_unbounded_membership_data() {
        for body in [
            br#"{}"#.as_slice(),
            br#"{"repos":[{"did":"not-a-did","custody":"pds"}]}"#.as_slice(),
            br#"{"repos":[],"cursor":""}"#.as_slice(),
        ] {
            assert_eq!(
                decode_page(body),
                Err(SpaceMembershipError::InvalidResponse)
            );
        }
        assert_eq!(
            validate_request(
                "at://did:web:stratos.example.test/space/zone.stratos.space.feed/crew",
                None,
                0
            ),
            Err(SpaceMembershipError::InvalidRequest)
        );
    }

    #[test]
    fn leaves_an_unresolvable_member_without_a_polling_host() {
        let page = decode_page(
            br#"{"repos":[{"did":"did:plc:member","custody":"pds","host":"http://unsafe.example.test/"}]}"#,
        )
        .unwrap();
        assert_eq!(page.members[0].custody, RepoCustody::Pds);
        assert_eq!(page.members[0].host, None);
    }

    #[test]
    fn keeps_service_and_public_endpoints_separate() {
        let client = HttpSpaceMembershipClient::new(
            "http://stratos.internal.test/base",
            "https://stratos.example.test/base",
        )
        .unwrap();
        assert_eq!(
            endpoint(&client.service_url).as_str(),
            "http://stratos.internal.test/base/xrpc/zone.stratos.space.listRepos"
        );
        assert!(
            HttpSpaceMembershipClient::new("https://stratos.example.test", "file:///unsafe")
                .is_err()
        );
    }
    #[tokio::test]
    async fn membership_signs_the_validated_authority_not_the_transport_url() {
        use crate::{
            space_credential::GrantedSpaceCredential, space_http_signature::SpaceHttpSignatureKey,
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(request.contains("authorization: Atproto-Space rei\r\n"));
            assert!(request.contains("atproto-space-audience: did:web:stratos.example.test\r\n"));
            assert!(request.contains(
                "signature-input: atproto-space=(\"authorization\" \"atproto-space-audience\")\r\n"
            ));
            assert!(!request.contains("dpop:"));
            stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 12\r\nconnection: close\r\n\r\n{\"repos\":[]}").await.unwrap();
        });
        let client = HttpSpaceMembershipClient::new(
            &format!("http://{address}"),
            "https://public.example.test",
        )
        .unwrap();
        let grant =
            GrantedSpaceCredential::new("rei".to_owned(), SpaceHttpSignatureKey::generate())
                .unwrap();
        let space = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop";
        assert!(
            client
                .list(space, &grant, None, 10)
                .await
                .unwrap()
                .members
                .is_empty()
        );
        server.await.unwrap();
        for invalid in [
            "at://did:plc:rei/space/zone.stratos.space.feed/",
            "https://stratos.example.test",
            "at://did:plc:rei/space/zone.stratos.space.feed/bebop/extra",
        ] {
            assert!(super::space_authority(invalid).is_err());
        }
    }
}

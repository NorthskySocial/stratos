use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, StatusCode, redirect::Policy};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;

use crate::{
    identifier::Did,
    service_auth::{ServiceSigningKey, SpaceDelegationClaims, mint_space_delegation},
    space_credential::{DpopKey, SpaceCredentialError},
};

const MINT_METHOD: &str = "zone.stratos.space.getSpaceCredential";
const MINT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_MINT_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
const MAX_CREDENTIAL_LIFETIME_SECONDS: u64 = 4 * 60 * 60;

#[derive(Debug, Eq, PartialEq)]
pub enum CredentialMintError {
    InvalidConfiguration,
    Authentication,
    Unavailable,
    ResponseTooLarge,
    InvalidResponse,
    Serialization,
    Proof(SpaceCredentialError),
    Delegation,
}

impl std::fmt::Display for CredentialMintError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration => {
                formatter.write_str("credential mint configuration is invalid")
            }
            Self::Authentication => formatter.write_str("credential mint authentication failed"),
            Self::Unavailable => formatter.write_str("credential mint is unavailable"),
            Self::ResponseTooLarge => {
                formatter.write_str("credential mint response exceeded its limit")
            }
            Self::InvalidResponse => formatter.write_str("credential mint response is invalid"),
            Self::Serialization => {
                formatter.write_str("credential mint request serialization failed")
            }
            Self::Proof(error) => write!(formatter, "credential mint proof failed: {error}"),
            Self::Delegation => formatter.write_str("credential delegation could not be minted"),
        }
    }
}

impl std::error::Error for CredentialMintError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CredentialExpiry(u64);

impl CredentialExpiry {
    pub fn as_epoch_seconds(self) -> u64 {
        self.0
    }
}

pub struct IssuedSpaceCredential {
    pub credential: String,
    pub expires_at: CredentialExpiry,
}

pub struct HttpSpaceCredentialIssuer {
    client: Client,
    service_url: Url,
    public_url: Url,
    authority_did: String,
    feedgen_did: String,
    signing_key: ServiceSigningKey,
}

impl HttpSpaceCredentialIssuer {
    pub fn new(
        service_url: &str,
        public_url: &str,
        authority_did: impl Into<String>,
        feedgen_did: impl Into<String>,
        signing_key: ServiceSigningKey,
    ) -> Result<Self, CredentialMintError> {
        let service_url = validate_base_url(service_url)?;
        let public_url = validate_base_url(public_url)?;
        let authority_did = authority_did.into();
        let feedgen_did = feedgen_did.into();
        Did::parse(authority_did.clone()).map_err(|_| CredentialMintError::InvalidConfiguration)?;
        Did::parse(feedgen_did.clone()).map_err(|_| CredentialMintError::InvalidConfiguration)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(MINT_TIMEOUT)
            .timeout(MINT_TIMEOUT)
            .build()
            .map_err(|_| CredentialMintError::InvalidConfiguration)?;
        Ok(Self {
            client,
            service_url,
            public_url,
            authority_did,
            feedgen_did,
            signing_key,
        })
    }

    pub async fn mint(
        &self,
        space_uri: &str,
        key: &DpopKey,
        now: u64,
    ) -> Result<IssuedSpaceCredential, CredentialMintError> {
        if space_uri.is_empty() || space_uri.len() > 2_048 {
            return Err(CredentialMintError::InvalidConfiguration);
        }
        let jti = DpopKey::new_jti();
        let delegation = mint_space_delegation(
            &self.signing_key,
            SpaceDelegationClaims {
                issuer: &self.feedgen_did,
                space_uri,
                authority_did: &self.authority_did,
                jti: &jti,
            },
            now,
        )
        .map_err(|_| CredentialMintError::Delegation)?;
        let service_endpoint = mint_endpoint(&self.service_url);
        let public_endpoint = mint_endpoint(&self.public_url);
        let proof = key
            .mint_proof("POST", public_endpoint.as_str(), None, now)
            .map_err(CredentialMintError::Proof)?;
        let body = serde_json::to_vec(&MintRequest {
            space: space_uri,
            delegation_token: &delegation,
        })
        .map_err(|_| CredentialMintError::Serialization)?;
        let response = self
            .client
            .post(service_endpoint)
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .header("dpop", proof)
            .body(body)
            .send()
            .await
            .map_err(|_| CredentialMintError::Unavailable)?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(CredentialMintError::Authentication);
        }
        if !response.status().is_success() {
            return Err(CredentialMintError::Unavailable);
        }
        decode_issued_credential(&response_bytes(response).await?, now)
    }
}

#[derive(Serialize)]
struct MintRequest<'a> {
    space: &'a str,
    #[serde(rename = "delegationToken")]
    delegation_token: &'a str,
}

#[derive(Deserialize)]
struct MintResponse {
    credential: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
}

fn validate_base_url(value: &str) -> Result<Url, CredentialMintError> {
    let url = Url::parse(value).map_err(|_| CredentialMintError::InvalidConfiguration)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CredentialMintError::InvalidConfiguration);
    }
    Ok(url)
}

fn mint_endpoint(base: &Url) -> Url {
    let mut endpoint = base.clone();
    endpoint.set_path(&format!(
        "{}/xrpc/{MINT_METHOD}",
        base.path().trim_end_matches('/')
    ));
    endpoint
}

async fn response_bytes(mut response: reqwest::Response) -> Result<Vec<u8>, CredentialMintError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MINT_RESPONSE_BYTES as u64)
    {
        return Err(CredentialMintError::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| CredentialMintError::Unavailable)?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_MINT_RESPONSE_BYTES {
            return Err(CredentialMintError::ResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn decode_issued_credential(
    bytes: &[u8],
    now: u64,
) -> Result<IssuedSpaceCredential, CredentialMintError> {
    let response: MintResponse =
        serde_json::from_slice(bytes).map_err(|_| CredentialMintError::InvalidResponse)?;
    if response.credential.is_empty() || response.credential.len() > MAX_CREDENTIAL_BYTES {
        return Err(CredentialMintError::InvalidResponse);
    }
    let expires_at = credential_expiry(&response.credential)?;
    let reported_expiry: u64 = OffsetDateTime::parse(&response.expires_at, &Rfc3339)
        .map_err(|_| CredentialMintError::InvalidResponse)?
        .unix_timestamp()
        .try_into()
        .map_err(|_| CredentialMintError::InvalidResponse)?;
    if expires_at != reported_expiry
        || expires_at <= now
        || expires_at.saturating_sub(now) > MAX_CREDENTIAL_LIFETIME_SECONDS
    {
        return Err(CredentialMintError::InvalidResponse);
    }
    Ok(IssuedSpaceCredential {
        credential: response.credential,
        expires_at: CredentialExpiry(expires_at),
    })
}

fn credential_expiry(credential: &str) -> Result<u64, CredentialMintError> {
    #[derive(Deserialize)]
    struct Claims {
        exp: u64,
    }
    credential
        .split('.')
        .nth(1)
        .and_then(|payload| URL_SAFE_NO_PAD.decode(payload).ok())
        .and_then(|bytes| serde_json::from_slice::<Claims>(&bytes).ok())
        .map(|claims| claims.exp)
        .ok_or(CredentialMintError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use super::{CredentialMintError, decode_issued_credential, mint_endpoint, validate_base_url};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

    #[test]
    fn accepts_only_a_live_cross_checked_credential_grant() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"exp":1060}"#);
        let body = format!(
            r#"{{"credential":"header.{payload}.signature","expiresAt":"1970-01-01T00:17:40Z"}}"#
        );
        let issued = decode_issued_credential(body.as_bytes(), 1_000).unwrap();
        assert_eq!(issued.expires_at.as_epoch_seconds(), 1_060);
        let mismatched = body.replace("00:17:40", "00:17:41");
        assert!(matches!(
            decode_issued_credential(mismatched.as_bytes(), 1_000),
            Err(CredentialMintError::InvalidResponse)
        ));
    }

    #[test]
    fn preserves_authority_base_paths_in_mint_targets() {
        let base = validate_base_url("https://stratos.example.test/service/").unwrap();
        assert_eq!(
            mint_endpoint(&base).as_str(),
            "https://stratos.example.test/service/xrpc/zone.stratos.space.getSpaceCredential"
        );
    }
}

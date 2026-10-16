use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, StatusCode, redirect::Policy};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;

use async_trait::async_trait;

use crate::{
    identifier::Did,
    service_auth::{ServiceSigningKey, SpaceDelegationClaims, mint_space_delegation},
    space_http_signature::{SpaceHttpSignatureError, SpaceHttpSignatureKey},
};

const MINT_METHOD: &str = "zone.stratos.space.getSpaceCredential";
const MINT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_MINT_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
const MAX_CREDENTIAL_LIFETIME_SECONDS: u64 = 60 * 60;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialMintError {
    InvalidConfiguration,
    Authentication,
    Unavailable,
    ResponseTooLarge,
    InvalidResponse,
    Serialization,
    Proof(SpaceHttpSignatureError),
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

#[async_trait]
pub trait SpaceCredentialIssuer: Send + Sync {
    async fn mint(
        &self,
        space_uri: &str,
        key: &SpaceHttpSignatureKey,
        now: u64,
    ) -> Result<IssuedSpaceCredential, CredentialMintError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CredentialExpiry(u64);

impl CredentialExpiry {
    #[cfg(test)]
    pub(crate) fn from_epoch_seconds(value: u64) -> Self {
        Self(value)
    }

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
        validate_base_url(public_url)?;
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
            authority_did,
            feedgen_did,
            signing_key,
        })
    }

    async fn mint_inner(
        &self,
        space_uri: &str,
        key: &SpaceHttpSignatureKey,
        now: u64,
    ) -> Result<IssuedSpaceCredential, CredentialMintError> {
        if space_uri.is_empty() || space_uri.len() > 2_048 {
            return Err(CredentialMintError::InvalidConfiguration);
        }
        let jti = new_jti();
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
        let proof = key
            .exchange_headers(&delegation)
            .map_err(CredentialMintError::Proof)?;
        let body = serde_json::to_vec(&MintRequest { space: space_uri })
            .map_err(|_| CredentialMintError::Serialization)?;
        let response = self
            .client
            .post(service_endpoint)
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .header("authorization", proof.authorization())
            .header("signature-input", proof.signature_input())
            .header("signature", proof.signature())
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
        decode_issued_credential(
            &response_bytes(response).await?,
            now,
            &self.authority_did,
            space_uri,
            key.key_id(),
        )
    }
}

#[async_trait]
impl SpaceCredentialIssuer for HttpSpaceCredentialIssuer {
    async fn mint(
        &self,
        space_uri: &str,
        key: &SpaceHttpSignatureKey,
        now: u64,
    ) -> Result<IssuedSpaceCredential, CredentialMintError> {
        self.mint_inner(space_uri, key, now).await
    }
}

#[derive(Serialize)]
struct MintRequest<'a> {
    space: &'a str,
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

fn new_jti() -> String {
    use p256::elliptic_curve::rand_core::{OsRng, RngCore};
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_issued_credential(
    bytes: &[u8],
    now: u64,
    authority: &str,
    space: &str,
    key_id: &str,
) -> Result<IssuedSpaceCredential, CredentialMintError> {
    let invalid = || CredentialMintError::InvalidResponse;
    let response: MintResponse = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if response.credential.is_empty() || response.credential.len() > MAX_CREDENTIAL_BYTES {
        return Err(invalid());
    }
    let parts: Vec<_> = response.credential.split('.').collect();
    let [header, payload, signature] = parts.as_slice() else {
        return Err(invalid());
    };
    #[derive(Deserialize)]
    struct Header {
        typ: String,
        alg: String,
    }
    #[derive(Deserialize)]
    struct Confirmation {
        kid: String,
    }
    #[derive(Deserialize)]
    struct Claims {
        iss: String,
        sub: String,
        cnf: Confirmation,
        jti: String,
        iat: u64,
        exp: u64,
    }
    let header: Header =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    let claims: Claims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if header.typ != "atproto-space-credential+jwt"
        || header.alg.is_empty()
        || header.alg == "none"
        || URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| invalid())?
            .is_empty()
        || claims.iss != authority
        || claims.sub != space
        || claims.cnf.kid != key_id
        || claims.jti.trim().is_empty()
        || claims.exp <= claims.iat
        || claims.exp - claims.iat > MAX_CREDENTIAL_LIFETIME_SECONDS
        || claims.iat > now.saturating_add(5)
        || claims.exp <= now
    {
        return Err(invalid());
    }
    let reported_expiry =
        OffsetDateTime::parse(&response.expires_at, &Rfc3339).map_err(|_| invalid())?;
    if i128::from(claims.exp) * 1_000_000_000 != reported_expiry.unix_timestamp_nanos() {
        return Err(invalid());
    }
    Ok(IssuedSpaceCredential {
        credential: response.credential,
        expires_at: CredentialExpiry(claims.exp),
    })
}

#[cfg(test)]
mod tests {
    use super::{CredentialMintError, decode_issued_credential, mint_endpoint, validate_base_url};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

    use serde_json::{Value, json};

    const AUTHORITY: &str = "did:web:stratos.example.test";
    const SPACE: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop";
    const KEY: &str = "did:key:rei";

    fn claims() -> Value {
        json!({"iss": AUTHORITY, "sub": SPACE, "cnf": {"kid": KEY}, "jti": "rei", "iat": 1000, "exp": 1060})
    }

    fn body(claims: Value) -> Vec<u8> {
        let header =
            URL_SAFE_NO_PAD.encode(br#"{"typ":"atproto-space-credential+jwt","alg":"ES256"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        serde_json::to_vec(&json!({"credential": format!("{header}.{payload}.c2ln"), "expiresAt": "1970-01-01T00:17:40Z"})).unwrap()
    }

    #[test]
    fn accepts_only_a_live_cross_checked_credential_grant() {
        let issued =
            decode_issued_credential(&body(claims()), 1000, AUTHORITY, SPACE, KEY).unwrap();
        assert_eq!(issued.expires_at.as_epoch_seconds(), 1060);
        for (field, value) in [
            ("iss", json!("did:plc:asuka")),
            ("sub", json!("other")),
            ("cnf", json!({"kid": "did:key:misato"})),
            ("jti", json!("")),
            ("jti", json!(" ")),
            ("iat", json!(1006)),
            ("iat", json!(1060)),
            ("iat", json!(1061)),
            ("exp", json!(8200)),
            ("exp", json!(1000)),
            ("iat", json!(-1)),
            ("exp", json!(1060.5)),
        ] {
            let mut invalid = claims();
            invalid[field] = value;
            assert!(
                matches!(
                    decode_issued_credential(&body(invalid), 1000, AUTHORITY, SPACE, KEY),
                    Err(CredentialMintError::InvalidResponse)
                ),
                "{field}"
            );
        }
        for field in ["iss", "sub", "cnf", "jti", "iat", "exp"] {
            let mut invalid = claims();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(decode_issued_credential(&body(invalid), 1000, AUTHORITY, SPACE, KEY).is_err());
        }
        assert!(decode_issued_credential(&body(claims()), 1060, AUTHORITY, SPACE, KEY).is_err());
        let mut skew = claims();
        skew["iat"] = json!(1005);
        assert!(decode_issued_credential(&body(skew), 1000, AUTHORITY, SPACE, KEY).is_ok());
        let mut boundary = claims();
        boundary["iat"] = json!(0);
        boundary["exp"] = json!(3600);
        let accepted = String::from_utf8(body(boundary.clone()))
            .unwrap()
            .replace("00:17:40", "01:00:00");
        assert!(decode_issued_credential(accepted.as_bytes(), 1000, AUTHORITY, SPACE, KEY).is_ok());
        boundary["exp"] = json!(3601);
        assert!(decode_issued_credential(&body(boundary), 1000, AUTHORITY, SPACE, KEY).is_err());
        let mismatched = String::from_utf8(body(claims()))
            .unwrap()
            .replace("00:17:40Z", "00:17:40.001Z");
        assert!(
            decode_issued_credential(mismatched.as_bytes(), 1000, AUTHORITY, SPACE, KEY).is_err()
        );
    }

    #[test]
    fn preserves_authority_base_paths_in_mint_targets() {
        let base = validate_base_url("https://stratos.example.test/service/").unwrap();
        assert_eq!(
            mint_endpoint(&base).as_str(),
            "https://stratos.example.test/service/xrpc/zone.stratos.space.getSpaceCredential"
        );
    }
    #[tokio::test]
    async fn exchanges_bearer_delegation_with_signature_and_space_only_body() {
        use crate::{service_auth::ServiceSigningKey, space_http_signature::SpaceHttpSignatureKey};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let key = SpaceHttpSignatureKey::generate();
        let key_id = key.key_id().to_owned();
        let mut payload = claims();
        payload["cnf"]["kid"] = json!(key_id);
        let response = body(payload);
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let count = stream.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            let (headers, body) = request.split_once("\r\n\r\n").unwrap();
            assert!(headers.contains("authorization: Bearer "));
            assert!(headers.contains(&format!(
                "signature-input: atproto-space=(\"authorization\");keyid=\"{key_id}\""
            )));
            assert!(headers.contains("signature: atproto-space=:"));
            assert!(!headers.contains("dpop:"));
            assert_eq!(
                serde_json::from_str::<Value>(body).unwrap(),
                json!({"space": SPACE})
            );
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                response.len()
            );
            stream.write_all(reply.as_bytes()).await.unwrap();
            stream.write_all(&response).await.unwrap();
        });
        let issuer = super::HttpSpaceCredentialIssuer::new(
            &format!("http://{address}"),
            "https://stratos.example.test",
            AUTHORITY,
            "did:web:feeds.stratos.example.test",
            ServiceSigningKey::from_hex(&"01".repeat(32)).unwrap(),
        )
        .unwrap();
        let issued = issuer.mint_inner(SPACE, &key, 1000).await.unwrap();
        assert_eq!(issued.expires_at.as_epoch_seconds(), 1060);
        server.await.unwrap();
    }
}

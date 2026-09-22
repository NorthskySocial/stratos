use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::{
    SecretKey,
    ecdsa::{Signature, SigningKey, signature::Signer},
    elliptic_curve::rand_core::{OsRng, RngCore},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;

use crate::space_host::{SpaceCredentialProof, SpaceHostError};

const DPOP_TYP: &str = "dpop+jwt";
const DPOP_ALG: &str = "ES256";

pub struct DpopKey {
    signing_key: SigningKey,
    jwk: DpopJwk,
}

impl DpopKey {
    pub fn generate() -> Self {
        let secret = SecretKey::random(&mut OsRng);
        let signing_key = SigningKey::from(secret);
        let point = signing_key.verifying_key().to_encoded_point(false);
        Self {
            signing_key,
            jwk: DpopJwk {
                crv: "P-256",
                kty: "EC",
                x: URL_SAFE_NO_PAD.encode(point.x().expect("uncompressed P-256 point has x")),
                y: URL_SAFE_NO_PAD.encode(point.y().expect("uncompressed P-256 point has y")),
            },
        }
    }

    pub fn new_jti() -> String {
        let mut bytes = [0_u8; 16];
        OsRng.fill_bytes(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    }

    pub fn mint_proof(
        &self,
        method: &str,
        target_uri: &str,
        credential: Option<&str>,
        now: u64,
    ) -> Result<String, SpaceCredentialError> {
        if method.is_empty() {
            return Err(SpaceCredentialError::InvalidMethod);
        }
        let target_uri = normalize_target_uri(target_uri)?;
        let header = encode_json(&DpopHeader {
            algorithm: DPOP_ALG,
            kind: DPOP_TYP,
            jwk: &self.jwk,
        })?;
        let claims = encode_json(&DpopClaims {
            jti: Self::new_jti(),
            method,
            target_uri: &target_uri,
            issued_at: now,
            access_token_hash: credential.map(token_hash),
        })?;
        let signed = format!("{header}.{claims}");
        let signature: Signature = self.signing_key.sign(signed.as_bytes());
        Ok(format!(
            "{signed}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        ))
    }
}

#[derive(Serialize)]
struct DpopJwk {
    crv: &'static str,
    kty: &'static str,
    x: String,
    y: String,
}

#[derive(Serialize)]
struct DpopHeader<'a> {
    #[serde(rename = "alg")]
    algorithm: &'static str,
    #[serde(rename = "typ")]
    kind: &'static str,
    jwk: &'a DpopJwk,
}

#[derive(Serialize)]
struct DpopClaims<'a> {
    jti: String,
    #[serde(rename = "htm")]
    method: &'a str,
    #[serde(rename = "htu")]
    target_uri: &'a str,
    #[serde(rename = "iat")]
    issued_at: u64,
    #[serde(rename = "ath", skip_serializing_if = "Option::is_none")]
    access_token_hash: Option<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum SpaceCredentialError {
    InvalidProofTarget,
    InvalidMethod,
    EmptyCredential,
    Serialization,
}

impl std::fmt::Display for SpaceCredentialError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidProofTarget => formatter.write_str("DPoP proof target is invalid"),
            Self::InvalidMethod => formatter.write_str("DPoP proof method is invalid"),
            Self::EmptyCredential => formatter.write_str("space credential is empty"),
            Self::Serialization => formatter.write_str("DPoP proof serialization failed"),
        }
    }
}
impl std::error::Error for SpaceCredentialError {}

pub struct HeldSpaceCredential {
    credential: String,
    key: DpopKey,
    now: fn() -> u64,
}

impl HeldSpaceCredential {
    pub fn new(
        credential: String,
        key: DpopKey,
        now: fn() -> u64,
    ) -> Result<Self, SpaceCredentialError> {
        if credential.is_empty() {
            return Err(SpaceCredentialError::EmptyCredential);
        }
        Ok(Self {
            credential,
            key,
            now,
        })
    }
    pub fn dpop_key(&self) -> &DpopKey {
        &self.key
    }
}

#[async_trait::async_trait]
impl SpaceCredentialProof for HeldSpaceCredential {
    fn credential(&self) -> &str {
        &self.credential
    }
    async fn presentation_proof(
        &self,
        method: &str,
        target_uri: &str,
    ) -> Result<String, SpaceHostError> {
        self.key
            .mint_proof(method, target_uri, Some(&self.credential), (self.now)())
            .map_err(|_| SpaceHostError::Proof)
    }
}

fn normalize_target_uri(value: &str) -> Result<String, SpaceCredentialError> {
    let mut url = Url::parse(value).map_err(|_| SpaceCredentialError::InvalidProofTarget)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(SpaceCredentialError::InvalidProofTarget);
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}
fn token_hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}
fn encode_json(value: &impl Serialize) -> Result<String, SpaceCredentialError> {
    serde_json::to_vec(value)
        .map(|value| URL_SAFE_NO_PAD.encode(value))
        .map_err(|_| SpaceCredentialError::Serialization)
}

#[cfg(test)]
mod tests {
    use super::{DpopKey, SpaceCredentialError};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use p256::ecdsa::{Signature, signature::Verifier};
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    #[test]
    fn creates_a_verifiable_p256_proof_with_a_normalized_target() {
        let key = DpopKey::generate();
        let proof = key
            .mint_proof(
                "GET",
                "https://pds.example.test/xrpc/read?cursor=private#ignore",
                Some("credential"),
                1_000,
            )
            .unwrap();
        let segments = proof.split('.').collect::<Vec<_>>();
        let [header, claims, signature] = segments.as_slice() else {
            panic!("proof has three segments")
        };
        let decoded_header: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).unwrap()).unwrap();
        let decoded_claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap();
        assert_eq!(decoded_header["alg"], "ES256");
        assert_eq!(decoded_claims["htu"], "https://pds.example.test/xrpc/read");
        assert_eq!(
            decoded_claims["ath"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(b"credential"))
        );
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).unwrap()).unwrap();
        key.signing_key
            .verifying_key()
            .verify(format!("{header}.{claims}").as_bytes(), &signature)
            .unwrap();
    }
    #[test]
    fn omits_ath_for_credential_minting_and_rejects_unsafe_targets() {
        let key = DpopKey::generate();
        let proof = key
            .mint_proof(
                "POST",
                "https://stratos.example.test/xrpc/mint",
                None,
                1_000,
            )
            .unwrap();
        let claims: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(proof.split('.').nth(1).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert!(claims.get("ath").is_none());
        assert_eq!(
            key.mint_proof("GET", "file:///tmp/secret", None, 1_000),
            Err(SpaceCredentialError::InvalidProofTarget)
        );
        assert_eq!(
            key.mint_proof("", "https://stratos.example.test/xrpc/mint", None, 1_000),
            Err(SpaceCredentialError::InvalidMethod)
        );
    }
}

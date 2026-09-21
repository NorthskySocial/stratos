use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::signature::Verifier;
use serde::Deserialize;

const FORBIDDEN_TOKEN_TYPES: [&str; 3] = ["at+jwt", "dpop+jwt", "refresh+jwt"];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedFeedRequest {
    pub viewer_did: String,
    pub lxm: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthError {
    AuthMissing,
    InvalidToken,
    ExpiredToken,
    BadJwtAudience,
    BadJwtLexiconMethod,
    BadJwtSignature,
    BadJwtType,
    CouldNotResolveIssuer,
}

impl AuthError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AuthMissing => "AuthMissing",
            Self::InvalidToken => "InvalidToken",
            Self::ExpiredToken => "ExpiredToken",
            Self::BadJwtAudience => "BadJwtAudience",
            Self::BadJwtLexiconMethod => "BadJwtLexiconMethod",
            Self::BadJwtSignature => "BadJwtSignature",
            Self::BadJwtType => "BadJwtType",
            Self::CouldNotResolveIssuer => "CouldNotResolveIssuer",
        }
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for AuthError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentityResolutionError;

#[async_trait]
pub trait IdentityKeyResolver: Send + Sync {
    async fn resolve_atproto_key(
        &self,
        did: &str,
        force_refresh: bool,
    ) -> Result<String, IdentityResolutionError>;
}

pub struct FeedRequestVerifier<R> {
    feedgen_did: String,
    allowed_lxms: Vec<String>,
    resolver: R,
}

impl<R> FeedRequestVerifier<R>
where
    R: IdentityKeyResolver,
{
    pub fn new(
        feedgen_did: impl Into<String>,
        allowed_lxms: impl IntoIterator<Item = String>,
        resolver: R,
    ) -> Self {
        Self {
            feedgen_did: feedgen_did.into(),
            allowed_lxms: allowed_lxms.into_iter().collect(),
            resolver,
        }
    }

    pub async fn verify_authorization(
        &self,
        authorization: Option<&str>,
        now: u64,
    ) -> Result<VerifiedFeedRequest, AuthError> {
        let token = extract_bearer_token(authorization)?;
        let parsed = ParsedJwt::parse(token)?;
        parsed.validate_claims(&self.feedgen_did, &self.allowed_lxms, now)?;
        let key = self.resolve_key(&parsed.claims.issuer, false).await?;
        if !key.verify(&parsed) {
            let refreshed_key = self.resolve_key(&parsed.claims.issuer, true).await?;
            if !refreshed_key.verify(&parsed) {
                return Err(AuthError::BadJwtSignature);
            }
        }
        Ok(VerifiedFeedRequest {
            viewer_did: parsed.claims.issuer,
            lxm: parsed.claims.lxm.expect("validated above"),
        })
    }

    async fn resolve_key(
        &self,
        issuer: &str,
        force_refresh: bool,
    ) -> Result<VerificationKey, AuthError> {
        let did_key = self
            .resolver
            .resolve_atproto_key(issuer, force_refresh)
            .await
            .map_err(|_| AuthError::CouldNotResolveIssuer)?;
        VerificationKey::from_did_key(&did_key)
    }
}

fn extract_bearer_token(authorization: Option<&str>) -> Result<&str, AuthError> {
    let value = authorization.ok_or(AuthError::AuthMissing)?;
    let mut parts = value.split(' ');
    let scheme = parts.next();
    let token = parts.next();
    if !scheme.is_some_and(|scheme| scheme.eq_ignore_ascii_case("bearer"))
        || token.is_none_or(str::is_empty)
        || parts.next().is_some()
    {
        return Err(AuthError::InvalidToken);
    }
    Ok(token.expect("checked above"))
}

struct ParsedJwt {
    algorithm: JwtAlgorithm,
    claims: JwtClaims,
    signed_data: Vec<u8>,
    signature: Vec<u8>,
}

impl ParsedJwt {
    fn parse(token: &str) -> Result<Self, AuthError> {
        let segments = token.split('.').collect::<Vec<_>>();
        let [header_segment, claims_segment, signature_segment] = segments.as_slice() else {
            return Err(AuthError::InvalidToken);
        };
        let header: JwtHeader = decode_json(header_segment)?;
        if header
            .typ
            .as_deref()
            .is_some_and(|kind| FORBIDDEN_TOKEN_TYPES.contains(&kind))
        {
            return Err(AuthError::BadJwtType);
        }
        let claims = decode_json(claims_segment)?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature_segment)
            .map_err(|_| AuthError::InvalidToken)?;
        Ok(Self {
            algorithm: JwtAlgorithm::parse(&header.alg)?,
            claims,
            signed_data: format!("{header_segment}.{claims_segment}").into_bytes(),
            signature,
        })
    }

    fn validate_claims(
        &self,
        feedgen_did: &str,
        allowed_lxms: &[String],
        now: u64,
    ) -> Result<(), AuthError> {
        crate::identifier::Did::parse(self.claims.issuer.clone())
            .map_err(|_| AuthError::InvalidToken)?;
        if self.claims.expires_at <= now {
            return Err(AuthError::ExpiredToken);
        }
        if self.claims.audience != feedgen_did {
            return Err(AuthError::BadJwtAudience);
        }
        if self
            .claims
            .lxm
            .as_deref()
            .is_none_or(|lxm| !allowed_lxms.iter().any(|allowed| allowed == lxm))
        {
            return Err(AuthError::BadJwtLexiconMethod);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct JwtHeader {
    alg: String,
    typ: Option<String>,
}

#[derive(Deserialize)]
struct JwtClaims {
    #[serde(rename = "iss")]
    issuer: String,
    #[serde(rename = "aud")]
    audience: String,
    #[serde(rename = "exp")]
    expires_at: u64,
    lxm: Option<String>,
}

fn decode_json<T: serde::de::DeserializeOwned>(encoded: &str) -> Result<T, AuthError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AuthError::InvalidToken)?;
    serde_json::from_slice(&decoded).map_err(|_| AuthError::InvalidToken)
}

#[derive(Clone, Copy)]
enum JwtAlgorithm {
    Es256,
    Es256k,
}

impl JwtAlgorithm {
    fn parse(value: &str) -> Result<Self, AuthError> {
        match value {
            "ES256" => Ok(Self::Es256),
            "ES256K" => Ok(Self::Es256k),
            _ => Err(AuthError::InvalidToken),
        }
    }
}

enum VerificationKey {
    P256(p256::ecdsa::VerifyingKey),
    Secp256k1(k256::ecdsa::VerifyingKey),
}

impl VerificationKey {
    fn from_did_key(value: &str) -> Result<Self, AuthError> {
        let encoded = value
            .strip_prefix("did:key:z")
            .ok_or(AuthError::InvalidToken)?;
        let bytes = bs58::decode(encoded)
            .into_vec()
            .map_err(|_| AuthError::InvalidToken)?;
        let (codec, key) = decode_multicodec(&bytes)?;
        match codec {
            0x1200 => p256::ecdsa::VerifyingKey::from_sec1_bytes(key)
                .map(Self::P256)
                .map_err(|_| AuthError::InvalidToken),
            0xe7 => k256::ecdsa::VerifyingKey::from_sec1_bytes(key)
                .map(Self::Secp256k1)
                .map_err(|_| AuthError::InvalidToken),
            _ => Err(AuthError::InvalidToken),
        }
    }

    fn verify(&self, jwt: &ParsedJwt) -> bool {
        match (self, jwt.algorithm) {
            (Self::P256(key), JwtAlgorithm::Es256) => {
                p256::ecdsa::Signature::from_slice(&jwt.signature)
                    .is_ok_and(|signature| key.verify(&jwt.signed_data, &signature).is_ok())
            }
            (Self::Secp256k1(key), JwtAlgorithm::Es256k) => {
                k256::ecdsa::Signature::from_slice(&jwt.signature)
                    .is_ok_and(|signature| key.verify(&jwt.signed_data, &signature).is_ok())
            }
            _ => false,
        }
    }
}

fn decode_multicodec(bytes: &[u8]) -> Result<(u64, &[u8]), AuthError> {
    let mut value = 0_u64;
    for (index, byte) in bytes.iter().copied().enumerate() {
        let shift = index.checked_mul(7).ok_or(AuthError::InvalidToken)?;
        if shift >= u64::BITS as usize {
            return Err(AuthError::InvalidToken);
        }
        let payload = byte & 0x7f;
        if shift == 63 && (payload > 1 || byte & 0x80 != 0) {
            return Err(AuthError::InvalidToken);
        }
        value |= u64::from(payload) << shift;
        if byte & 0x80 == 0 {
            if index > 0 && payload == 0 {
                return Err(AuthError::InvalidToken);
            }
            return Ok((value, &bytes[index + 1..]));
        }
    }
    Err(AuthError::InvalidToken)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use k256::ecdsa::SigningKey as Secp256k1SigningKey;
    use p256::ecdsa::{SigningKey as P256SigningKey, signature::Signer};

    use super::{AuthError, FeedRequestVerifier, IdentityKeyResolver, IdentityResolutionError};

    const FEEDGEN_DID: &str = "did:web:feedgen.example.test";
    const USER_DID: &str = "did:plc:spike";
    const GET_FEED: &str = "zone.stratos.feedgen.getFeed";
    const NOW: u64 = 1_790_000_000;

    struct StubResolver {
        keys: [String; 2],
        fail: bool,
        calls: Mutex<Vec<bool>>,
    }

    #[async_trait]
    impl IdentityKeyResolver for StubResolver {
        async fn resolve_atproto_key(
            &self,
            _did: &str,
            force_refresh: bool,
        ) -> Result<String, IdentityResolutionError> {
            self.calls.lock().unwrap().push(force_refresh);
            if self.fail {
                return Err(IdentityResolutionError);
            }
            Ok(self.keys[usize::from(force_refresh)].clone())
        }
    }

    fn verifier(initial_key: String, refreshed_key: String) -> FeedRequestVerifier<StubResolver> {
        FeedRequestVerifier::new(
            FEEDGEN_DID,
            [GET_FEED.to_owned()],
            StubResolver {
                keys: [initial_key, refreshed_key],
                fail: false,
                calls: Mutex::new(Vec::new()),
            },
        )
    }

    fn did_key(codec: u64, key: &[u8]) -> String {
        let mut bytes = Vec::new();
        let mut codec = codec;
        loop {
            let mut byte = (codec & 0x7f) as u8;
            codec >>= 7;
            if codec != 0 {
                byte |= 0x80;
            }
            bytes.push(byte);
            if codec == 0 {
                break;
            }
        }
        bytes.extend_from_slice(key);
        format!("did:key:z{}", bs58::encode(bytes).into_string())
    }

    fn p256_key() -> P256SigningKey {
        P256SigningKey::from_bytes((&[7_u8; 32]).into()).unwrap()
    }

    fn p256_did_key(key: &P256SigningKey) -> String {
        did_key(
            0x1200,
            key.verifying_key().to_encoded_point(true).as_bytes(),
        )
    }

    fn secp256k1_key() -> Secp256k1SigningKey {
        Secp256k1SigningKey::from_bytes((&[9_u8; 32]).into()).unwrap()
    }

    fn secp256k1_did_key(key: &Secp256k1SigningKey) -> String {
        did_key(0xe7, key.verifying_key().to_encoded_point(true).as_bytes())
    }

    fn p256_token(
        key: &P256SigningKey,
        audience: &str,
        lxm: Option<&str>,
        expires_at: u64,
        typ: Option<&str>,
    ) -> String {
        p256_token_for_issuer(key, USER_DID, audience, lxm, expires_at, typ)
    }

    fn p256_token_for_issuer(
        key: &P256SigningKey,
        issuer: &str,
        audience: &str,
        lxm: Option<&str>,
        expires_at: u64,
        typ: Option<&str>,
    ) -> String {
        let header = serde_json::json!({ "alg": "ES256", "typ": typ.unwrap_or("JWT") });
        let mut claims = serde_json::json!({
            "iss": issuer,
            "aud": audience,
            "exp": expires_at,
        });
        if let Some(lxm) = lxm {
            claims["lxm"] = serde_json::Value::String(lxm.to_owned());
        }
        let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap());
        let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let signed_data = format!("{header}.{claims}");
        let signature: p256::ecdsa::Signature = key.sign(signed_data.as_bytes());
        format!(
            "{signed_data}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    fn secp256k1_token(key: &Secp256k1SigningKey) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256K","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "iss": USER_DID,
                "aud": FEEDGEN_DID,
                "exp": NOW + 60,
                "lxm": GET_FEED,
            }))
            .unwrap(),
        );
        let signed_data = format!("{header}.{claims}");
        let signature: k256::ecdsa::Signature = key.sign(signed_data.as_bytes());
        format!(
            "{signed_data}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    #[tokio::test]
    async fn verifies_a_p256_service_jwt() {
        let key = p256_key();
        let token = p256_token(&key, FEEDGEN_DID, Some(GET_FEED), NOW + 60, None);
        let verifier = verifier(p256_did_key(&key), p256_did_key(&key));

        assert_eq!(
            verifier
                .verify_authorization(Some(&format!("Bearer {token}")), NOW)
                .await
                .unwrap()
                .viewer_did,
            USER_DID
        );
    }

    #[tokio::test]
    async fn verifies_a_secp256k1_service_jwt() {
        let key = secp256k1_key();
        let token = secp256k1_token(&key);
        let verifier = verifier(secp256k1_did_key(&key), secp256k1_did_key(&key));

        assert_eq!(
            verifier
                .verify_authorization(Some(&format!("Bearer {token}")), NOW)
                .await
                .unwrap()
                .viewer_did,
            USER_DID
        );
    }

    #[tokio::test]
    async fn rejects_missing_expired_or_bad_method_tokens() {
        let key = p256_key();
        let did_key = p256_did_key(&key);
        let verifier = verifier(did_key.clone(), did_key);

        assert_eq!(
            verifier.verify_authorization(None, NOW).await.unwrap_err(),
            AuthError::AuthMissing
        );
        let expired = p256_token(&key, FEEDGEN_DID, Some(GET_FEED), NOW, None);
        assert_eq!(
            verifier
                .verify_authorization(Some(&format!("Bearer {expired}")), NOW)
                .await
                .unwrap_err(),
            AuthError::ExpiredToken
        );
        let wrong_lxm = p256_token(
            &key,
            FEEDGEN_DID,
            Some("zone.stratos.other"),
            NOW + 60,
            None,
        );
        assert_eq!(
            verifier
                .verify_authorization(Some(&format!("Bearer {wrong_lxm}")), NOW)
                .await
                .unwrap_err(),
            AuthError::BadJwtLexiconMethod
        );
        let invalid_issuer = p256_token_for_issuer(
            &key,
            "not-a-did",
            FEEDGEN_DID,
            Some(GET_FEED),
            NOW + 60,
            None,
        );
        assert_eq!(
            verifier
                .verify_authorization(Some(&format!("Bearer {invalid_issuer}")), NOW)
                .await
                .unwrap_err(),
            AuthError::InvalidToken
        );
    }

    #[tokio::test]
    async fn rejects_wrong_audience_or_forbidden_token_type() {
        let key = p256_key();
        let did_key = p256_did_key(&key);
        let verifier = verifier(did_key.clone(), did_key);
        let wrong_audience = p256_token(
            &key,
            "did:web:other.example.test",
            Some(GET_FEED),
            NOW + 60,
            None,
        );
        assert_eq!(
            verifier
                .verify_authorization(Some(&format!("Bearer {wrong_audience}")), NOW)
                .await
                .unwrap_err(),
            AuthError::BadJwtAudience
        );
        let forbidden_type = p256_token(
            &key,
            FEEDGEN_DID,
            Some(GET_FEED),
            NOW + 60,
            Some("dpop+jwt"),
        );
        assert_eq!(
            verifier
                .verify_authorization(Some(&format!("Bearer {forbidden_type}")), NOW)
                .await
                .unwrap_err(),
            AuthError::BadJwtType
        );
    }

    #[tokio::test]
    async fn refreshes_the_issuer_key_once_after_a_signature_failure() {
        let signing_key = p256_key();
        let stale_key = P256SigningKey::from_bytes((&[8_u8; 32]).into()).unwrap();
        let token = p256_token(&signing_key, FEEDGEN_DID, Some(GET_FEED), NOW + 60, None);
        let verifier = verifier(p256_did_key(&stale_key), p256_did_key(&signing_key));

        assert_eq!(
            verifier
                .verify_authorization(Some(&format!("Bearer {token}")), NOW)
                .await
                .unwrap()
                .viewer_did,
            USER_DID
        );
        assert_eq!(
            verifier.resolver.calls.lock().unwrap().as_slice(),
            [false, true]
        );
    }

    #[tokio::test]
    async fn rejects_a_forged_token_after_one_key_refresh() {
        let signing_key = p256_key();
        let other_key = P256SigningKey::from_bytes((&[8_u8; 32]).into()).unwrap();
        let token = p256_token(&signing_key, FEEDGEN_DID, Some(GET_FEED), NOW + 60, None);
        let verifier = verifier(p256_did_key(&other_key), p256_did_key(&other_key));

        assert_eq!(
            verifier
                .verify_authorization(Some(&format!("Bearer {token}")), NOW)
                .await
                .unwrap_err(),
            AuthError::BadJwtSignature
        );
        assert_eq!(
            verifier.resolver.calls.lock().unwrap().as_slice(),
            [false, true]
        );
    }

    #[test]
    fn rejects_noncanonical_and_overflowing_multicodecs() {
        assert!(super::decode_multicodec(&[0x80, 0xa4, 0x00]).is_err());
        assert!(
            super::decode_multicodec(&[0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x02])
                .is_err()
        );
    }
}

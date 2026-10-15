use base64::{Engine, engine::general_purpose::STANDARD};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use p256::elliptic_curve::rand_core::OsRng;

use crate::identifier::Did;

pub struct SpaceHttpSignatureKey {
    signing_key: SigningKey,
    key_id: String,
}

#[derive(Clone, Eq, PartialEq)]
pub struct SpaceHttpSignatureHeaders {
    authorization: String,
    audience: Option<Did>,
    signature_input: String,
    signature: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpaceHttpSignatureError {
    InvalidToken,
}

impl std::fmt::Display for SpaceHttpSignatureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("invalid space authorization token")
    }
}

impl std::error::Error for SpaceHttpSignatureError {}

impl SpaceHttpSignatureKey {
    pub fn generate() -> Self {
        Self::from_signing_key(SigningKey::random(&mut OsRng))
    }

    fn from_signing_key(signing_key: SigningKey) -> Self {
        let point = signing_key.verifying_key().to_encoded_point(true);
        let mut multikey = vec![0x80, 0x24];
        multikey.extend_from_slice(point.as_bytes());
        Self {
            signing_key,
            key_id: format!("did:key:z{}", bs58::encode(multikey).into_string()),
        }
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    pub fn exchange_headers(
        &self,
        delegation: &str,
    ) -> Result<SpaceHttpSignatureHeaders, SpaceHttpSignatureError> {
        validate_token(delegation)?;
        Ok(self.sign(
            format!("Bearer {delegation}"),
            None,
            format!("(\"authorization\");keyid=\"{}\"", self.key_id),
        ))
    }

    pub fn presentation_headers(
        &self,
        credential: &str,
        audience: &Did,
    ) -> Result<SpaceHttpSignatureHeaders, SpaceHttpSignatureError> {
        validate_token(credential)?;
        Ok(self.sign(
            format!("Atproto-Space {credential}"),
            Some(audience.clone()),
            "(\"authorization\" \"atproto-space-audience\")".to_owned(),
        ))
    }

    fn sign(
        &self,
        authorization: String,
        audience: Option<Did>,
        parameters: String,
    ) -> SpaceHttpSignatureHeaders {
        let base = signature_base(&authorization, audience.as_ref(), &parameters);
        let signature: Signature = self.signing_key.sign(base.as_bytes());
        SpaceHttpSignatureHeaders {
            authorization,
            audience,
            signature_input: format!("atproto-space={parameters}"),
            signature: format!("atproto-space=:{}:", STANDARD.encode(signature.to_bytes())),
        }
    }
}

impl SpaceHttpSignatureHeaders {
    pub fn authorization(&self) -> &str {
        &self.authorization
    }

    pub fn audience(&self) -> Option<&str> {
        self.audience.as_ref().map(Did::as_str)
    }

    pub fn signature_input(&self) -> &str {
        &self.signature_input
    }

    pub fn signature(&self) -> &str {
        &self.signature
    }
}

pub(crate) fn validate_token(token: &str) -> Result<(), SpaceHttpSignatureError> {
    if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(SpaceHttpSignatureError::InvalidToken);
    }
    Ok(())
}

fn signature_base(authorization: &str, audience: Option<&Did>, parameters: &str) -> String {
    let mut lines = vec![format!("\"authorization\": {}", authorization.trim())];
    if let Some(audience) = audience {
        lines.push(format!("\"atproto-space-audience\": {}", audience.as_str()));
    }
    lines.push(format!("\"@signature-params\": {parameters}"));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_key::DidVerificationKey;
    use p256::ecdsa::signature::Verifier;
    use serde_json::Value;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!(
            "../../stratos-service/tests/space-http-signature.fixtures.json"
        ))
        .unwrap()
    }

    #[test]
    fn space_credential_matches_pinned_typescript_exchange_and_presentation() {
        let fixture = fixtures();
        assert!(fixture["source"].as_str().unwrap().contains(
            "5b95b2f2723a2882824fbb0b819fd6aad884ef20/packages/space/src/http-signature.ts"
        ));
        let key =
            SpaceHttpSignatureKey::from_signing_key(SigningKey::from_slice(&[1; 32]).unwrap());
        assert_eq!(key.key_id(), fixture["keyId"]);
        let audience = Did::parse("did:plc:tokyo3").unwrap();
        for (name, headers) in [
            ("exchange", key.exchange_headers("rei-delegation").unwrap()),
            (
                "presentation",
                key.presentation_headers("misato-credential", &audience)
                    .unwrap(),
            ),
        ] {
            let expected = &fixture[name];
            assert_eq!(headers.authorization(), expected["authorization"]);
            assert_eq!(headers.signature_input(), expected["signature-input"]);
            let parameters = headers
                .signature_input()
                .strip_prefix("atproto-space=")
                .unwrap();
            let base = signature_base(
                headers.authorization(),
                headers.audience.as_ref(),
                parameters,
            );
            assert!(!base.ends_with('\n'));
            let signature = expected["signature"].as_str().unwrap();
            let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
                .decode(
                    signature
                        .strip_prefix("atproto-space=:")
                        .unwrap()
                        .strip_suffix(':')
                        .unwrap(),
                )
                .unwrap();
            assert_eq!(bytes.len(), 64);
            let signature = Signature::from_slice(&bytes).unwrap();
            key.signing_key
                .verifying_key()
                .verify(base.as_bytes(), &signature)
                .unwrap();
            let low = signature.normalize_s().unwrap_or(signature);
            let high = Signature::from_scalars(low.r().to_bytes(), (-low.s()).to_bytes()).unwrap();
            let verifier = DidVerificationKey::parse(key.key_id()).unwrap();
            for signature in [low, high] {
                assert_eq!(
                    verifier.verifies_p256(base.as_bytes(), &signature.to_bytes()),
                    Some(true)
                );
                assert_ne!(
                    verifier.verifies_p256(base.as_bytes(), signature.to_der().as_bytes()),
                    Some(true)
                );
            }
            let generated = STANDARD
                .decode(
                    headers
                        .signature()
                        .strip_prefix("atproto-space=:")
                        .unwrap()
                        .strip_suffix(':')
                        .unwrap(),
                )
                .unwrap();
            let generated = Signature::from_slice(&generated).unwrap();
            assert_eq!(generated.normalize_s().unwrap_or(generated), low);
            for altered in [
                format!("{base}\n"),
                base.replace("authorization", "Authorization"),
                base.replace("@signature-params", "@method"),
            ] {
                assert!(
                    key.signing_key
                        .verifying_key()
                        .verify(altered.as_bytes(), &signature)
                        .is_err()
                );
            }
        }
    }

    #[test]
    fn space_credential_canonical_bytes_cover_exact_fields_and_parameters() {
        let audience = Did::parse("did:plc:tokyo3").unwrap();
        assert_eq!(
            signature_base(
                " \tBearer rei\t ",
                None,
                "(\"authorization\");keyid=\"did:key:rei\""
            ),
            "\"authorization\": Bearer rei\n\"@signature-params\": (\"authorization\");keyid=\"did:key:rei\""
        );
        assert_eq!(
            signature_base(
                "Atproto-Space misato",
                Some(&audience),
                "(\"authorization\" \"atproto-space-audience\")"
            ),
            "\"authorization\": Atproto-Space misato\n\"atproto-space-audience\": did:plc:tokyo3\n\"@signature-params\": (\"authorization\" \"atproto-space-audience\")"
        );
    }

    #[test]
    fn space_credential_rejects_header_injection_and_signs_audience_not_host() {
        let key = SpaceHttpSignatureKey::generate();
        let audience = Did::parse("did:plc:tokyo3").unwrap();
        for token in [
            "",
            "rei misato",
            "rei\r\nx-secret: nerv",
            "rei\n",
            "rei\t",
            "rei\0",
            "綾波",
        ] {
            assert!(matches!(
                key.exchange_headers(token),
                Err(SpaceHttpSignatureError::InvalidToken)
            ));
            assert!(matches!(
                key.presentation_headers(token, &audience),
                Err(SpaceHttpSignatureError::InvalidToken)
            ));
        }
        let headers = key.presentation_headers("misato", &audience).unwrap();
        assert!(headers == key.presentation_headers("misato", &audience).unwrap());
        assert!(
            headers
                != key
                    .presentation_headers("misato", &Did::parse("did:plc:asuka").unwrap())
                    .unwrap()
        );
        assert_eq!(headers.audience(), Some("did:plc:tokyo3"));
        assert_eq!(key.exchange_headers("rei").unwrap().audience(), None);
    }
}

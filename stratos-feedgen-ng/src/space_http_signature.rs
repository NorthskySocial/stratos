use base64::{Engine, engine::general_purpose::STANDARD};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use p256::elliptic_curve::Generate;

use crate::identifier::Did;

const EXCHANGE_LABEL: &str = "atproto-space";
const PRESENTATION_LABEL: &str = "sig";
const PRESENTATION_SCHEME: &str = "Atproto-Space-Credential";
const PRESENTATION_COMPONENTS: &str = "(\"authorization\" \"atproto-space-audience\")";
const PRESENTATION_TAG: &str = "atproto-space-credential";

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
        Self::from_signing_key(SigningKey::generate())
    }

    fn from_signing_key(signing_key: SigningKey) -> Self {
        let point = signing_key.verifying_key().to_sec1_point(true);
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
            EXCHANGE_LABEL,
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
            PRESENTATION_LABEL,
            format!("{PRESENTATION_SCHEME} {credential}"),
            Some(audience.clone()),
            format!("{PRESENTATION_COMPONENTS};tag=\"{PRESENTATION_TAG}\""),
        ))
    }

    fn sign(
        &self,
        label: &str,
        authorization: String,
        audience: Option<Did>,
        parameters: String,
    ) -> SpaceHttpSignatureHeaders {
        let base = signature_base(&authorization, audience.as_ref(), &parameters);
        let signed: Signature = self.signing_key.sign(base.as_bytes());
        let signature = signed.normalize_s();
        SpaceHttpSignatureHeaders {
            authorization,
            audience,
            signature_input: format!("{label}={parameters}"),
            signature: format!("{label}=:{}:", STANDARD.encode(signature.to_bytes())),
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

    const FIXED_CREDENTIAL: &str = "misato-credential";
    const FIXED_AUDIENCE: &str = "did:plc:tokyo3";
    const FIXED_PRESENTATION_AUTHORIZATION: &str = "Atproto-Space-Credential misato-credential";
    const FIXED_PRESENTATION_SIGNATURE_INPUT: &str =
        "sig=(\"authorization\" \"atproto-space-audience\");tag=\"atproto-space-credential\"";
    // The upstream TypeScript signer's output for this key and input; it signs low-S.
    const UPSTREAM_PRESENTATION_SIGNATURE: &str = "sig=:a3jD9GLACE/7cxT/Ui44YkimF1tcWhWb9AgeYzQafP5X7CESqkIDp3uH7VNJUeHN4vFg/8BCnCxoe4mGCVkZNg==:";
    const FIXED_EXCHANGE_AUTHORIZATION: &str = "Bearer rei-delegation";
    const FIXED_EXCHANGE_SIGNATURE_INPUT: &str = "atproto-space=(\"authorization\");keyid=\"did:key:zDnaeXxvmFHMHjqgQTbadpWG7gPHwnga1i7SMwxrV2BSdUjAD\"";
    const FIXED_EXCHANGE_SIGNATURE: &str = "atproto-space=:eK8Y8zk7bC2CY6h+uaBC3knTw6bVJxqhoA/eZjfd5CRAnG28Jb9lwnxOuXlN7YjgiM07qAtzdw4lqW8X5h/HSQ==:";

    fn fixtures() -> Value {
        serde_json::from_str(include_str!(
            "../../stratos-service/tests/space-http-signature.fixtures.json"
        ))
        .unwrap()
    }

    fn presentation_vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../test/spaces-alignment/november/fixtures/credential-signature.json"
        ))
        .unwrap()
    }

    fn fixed_key() -> SpaceHttpSignatureKey {
        SpaceHttpSignatureKey::from_signing_key(SigningKey::from_slice(&[1; 32]).unwrap())
    }

    fn signature_bytes(field: &str, label: &str) -> Vec<u8> {
        STANDARD
            .decode(
                field
                    .strip_prefix(&format!("{label}=:"))
                    .unwrap()
                    .strip_suffix(':')
                    .unwrap(),
            )
            .unwrap()
    }

    #[test]
    fn space_credential_matches_pinned_typescript_exchange() {
        let fixture = fixtures();
        assert!(fixture["source"].as_str().unwrap().contains(
            "5b95b2f2723a2882824fbb0b819fd6aad884ef20/packages/space/src/http-signature.ts"
        ));
        let key = fixed_key();
        assert_eq!(key.key_id(), fixture["keyId"]);
        let headers = key.exchange_headers("rei-delegation").unwrap();
        let expected = &fixture["exchange"];
        assert_eq!(headers.authorization(), expected["authorization"]);
        assert_eq!(headers.signature_input(), expected["signature-input"]);
        let parameters = headers
            .signature_input()
            .strip_prefix("atproto-space=")
            .unwrap();
        let base = signature_base(headers.authorization(), None, parameters);
        assert!(!base.ends_with('\n'));
        let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(
                expected["signature"]
                    .as_str()
                    .unwrap()
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
        let low = signature.normalize_s();
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
        let generated =
            Signature::from_slice(&signature_bytes(headers.signature(), "atproto-space")).unwrap();
        assert_eq!(generated.normalize_s(), low);
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

    #[test]
    fn presentation_accepts_the_upstream_vector_under_the_base_this_module_builds() {
        let vectors = presentation_vectors();
        let accepted = &vectors["accepted"];
        let headers = &accepted["headers"];
        let audience = Did::parse(accepted["audience"].as_str().unwrap()).unwrap();
        let parameters = headers["signature-input"]
            .as_str()
            .unwrap()
            .strip_prefix("sig=")
            .unwrap();
        let base = signature_base(
            headers["authorization"].as_str().unwrap(),
            Some(&audience),
            parameters,
        );
        let verifier = DidVerificationKey::parse(accepted["keyId"].as_str().unwrap()).unwrap();
        let signature = signature_bytes(headers["signature"].as_str().unwrap(), "sig");
        assert_eq!(
            verifier.verifies_p256(base.as_bytes(), &signature),
            Some(true)
        );
        assert_ne!(
            verifier.verifies_p256(format!("{base}\n").as_bytes(), &signature),
            Some(true)
        );
    }

    #[test]
    fn presentation_headers_are_the_pinned_strings() {
        let key = fixed_key();
        let audience = Did::parse(FIXED_AUDIENCE).unwrap();
        let headers = key
            .presentation_headers(FIXED_CREDENTIAL, &audience)
            .unwrap();
        assert_eq!(headers.authorization(), FIXED_PRESENTATION_AUTHORIZATION);
        assert_eq!(headers.audience(), Some(FIXED_AUDIENCE));
        assert_eq!(
            headers.signature_input(),
            FIXED_PRESENTATION_SIGNATURE_INPUT
        );
        assert_eq!(headers.signature(), UPSTREAM_PRESENTATION_SIGNATURE);
    }

    #[test]
    fn presentation_signature_covers_the_sent_strings_and_no_other_bytes() {
        let key = fixed_key();
        let audience = Did::parse(FIXED_AUDIENCE).unwrap();
        let headers = key
            .presentation_headers(FIXED_CREDENTIAL, &audience)
            .unwrap();
        let parameters = headers.signature_input().strip_prefix("sig=").unwrap();
        let base = signature_base(headers.authorization(), Some(&audience), parameters);
        assert!(!base.ends_with('\n'));
        let signature =
            Signature::from_slice(&signature_bytes(headers.signature(), "sig")).unwrap();
        let verifying_key = key.signing_key.verifying_key();
        verifying_key.verify(base.as_bytes(), &signature).unwrap();
        let other_audience = Did::parse("did:plc:tokyo4").unwrap();
        for altered in [
            signature_base(
                "Atproto-Space-Credential misato-credentiaL",
                Some(&audience),
                parameters,
            ),
            signature_base(headers.authorization(), Some(&other_audience), parameters),
            signature_base(
                headers.authorization(),
                Some(&audience),
                "(\"authorization\")",
            ),
        ] {
            assert!(
                verifying_key
                    .verify(altered.as_bytes(), &signature)
                    .is_err()
            );
        }
    }

    #[test]
    fn exchange_headers_are_the_pinned_strings_and_carry_no_credential_tag() {
        let headers = fixed_key().exchange_headers("rei-delegation").unwrap();
        assert_eq!(headers.authorization(), FIXED_EXCHANGE_AUTHORIZATION);
        assert_eq!(headers.audience(), None);
        assert_eq!(headers.signature_input(), FIXED_EXCHANGE_SIGNATURE_INPUT);
        assert_eq!(headers.signature(), FIXED_EXCHANGE_SIGNATURE);
        assert!(!headers.signature_input().contains("tag="));
    }

    const SEEDED_KEYS: u8 = 96;

    fn is_low_s(signature: &Signature) -> bool {
        signature.normalize_s() == *signature
    }

    #[test]
    fn the_low_s_check_recognises_a_high_s_signature() {
        let key = fixed_key();
        let headers = key.exchange_headers("rei-delegation").unwrap();
        let signed =
            Signature::from_slice(&signature_bytes(headers.signature(), "atproto-space")).unwrap();
        let low = signed.normalize_s();
        let high = Signature::from_scalars(low.r().to_bytes(), (-low.s()).to_bytes()).unwrap();
        assert!(is_low_s(&low));
        assert!(!is_low_s(&high));
    }

    #[test]
    fn every_presentation_and_exchange_signature_is_low_s_and_verifies() {
        let audience = Did::parse(FIXED_AUDIENCE).unwrap();
        for seed in 1..=SEEDED_KEYS {
            let key = SpaceHttpSignatureKey::from_signing_key(
                SigningKey::from_slice(&[seed; 32]).unwrap(),
            );
            let token = format!("faye-valentine-{seed}");
            let presentation = key.presentation_headers(&token, &audience).unwrap();
            let exchange = key.exchange_headers(&token).unwrap();
            for (headers, label, audience) in [
                (&presentation, "sig", Some(&audience)),
                (&exchange, "atproto-space", None),
            ] {
                let signature =
                    Signature::from_slice(&signature_bytes(headers.signature(), label)).unwrap();
                assert!(is_low_s(&signature), "seed {seed} {label} is high-S");
                let parameters = headers
                    .signature_input()
                    .strip_prefix(&format!("{label}="))
                    .unwrap();
                let base = signature_base(headers.authorization(), audience, parameters);
                key.signing_key
                    .verifying_key()
                    .verify(base.as_bytes(), &signature)
                    .unwrap();
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
                "Atproto-Space-Credential misato",
                Some(&audience),
                "(\"authorization\" \"atproto-space-audience\")"
            ),
            "\"authorization\": Atproto-Space-Credential misato\n\"atproto-space-audience\": did:plc:tokyo3\n\"@signature-params\": (\"authorization\" \"atproto-space-audience\")"
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

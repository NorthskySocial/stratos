use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use k256::ecdsa::{Signature, SigningKey, signature::Signer};
use serde::Serialize;

pub const SERVICE_JWT_LIFETIME_SECONDS: u64 = 60;
pub const SPACE_DELEGATION_LIFETIME_SECONDS: u64 = 60;
/// Names the authority's host as the audience of a delegation, as the upstream
/// spaces contract does for the authority's PDS.
pub const SPACE_HOST_AUDIENCE_FRAGMENT: &str = "#atproto_pds";

#[derive(Clone, Eq, PartialEq)]
pub struct ServiceSigningKey([u8; 32]);

impl ServiceSigningKey {
    pub fn from_hex(value: &str) -> Result<Self, ServiceAuthError> {
        if value.len() != 64 {
            return Err(ServiceAuthError::InvalidSigningKey);
        }
        let mut bytes = [0_u8; 32];
        for (index, byte) in bytes.iter_mut().enumerate() {
            let offset = index * 2;
            let high = hex_nibble(value.as_bytes()[offset])?;
            let low = hex_nibble(value.as_bytes()[offset + 1])?;
            *byte = (high << 4) | low;
        }
        SigningKey::from_slice(&bytes).map_err(|_| ServiceAuthError::InvalidSigningKey)?;
        Ok(Self(bytes))
    }

    fn signer(&self) -> Result<SigningKey, ServiceAuthError> {
        SigningKey::from_slice(&self.0).map_err(|_| ServiceAuthError::InvalidSigningKey)
    }
}

fn hex_nibble(value: u8) -> Result<u8, ServiceAuthError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(ServiceAuthError::InvalidSigningKey),
    }
}

impl std::fmt::Debug for ServiceSigningKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ServiceSigningKey([REDACTED])")
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum ServiceAuthError {
    InvalidSigningKey,
    InvalidDelegationClaims,
    Serialization,
}

impl std::fmt::Display for ServiceAuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSigningKey => formatter.write_str("service signing key is invalid"),
            Self::InvalidDelegationClaims => {
                formatter.write_str("space delegation claims are invalid")
            }
            Self::Serialization => {
                formatter.write_str("service authentication token serialization failed")
            }
        }
    }
}

impl std::error::Error for ServiceAuthError {}

pub fn mint_service_jwt(
    key: &ServiceSigningKey,
    issuer: &str,
    audience: &str,
    lxm: &str,
    now: u64,
) -> Result<String, ServiceAuthError> {
    let header = encode_json(&JwtHeader {
        algorithm: "ES256K",
        kind: "JWT",
    })?;
    let claims = encode_json(&JwtClaims {
        issuer,
        audience,
        expires_at: now.saturating_add(SERVICE_JWT_LIFETIME_SECONDS),
        lxm,
    })?;
    let signed = format!("{header}.{claims}");
    let signature: Signature = key.signer()?.sign(signed.as_bytes());
    Ok(format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

pub fn mint_space_delegation(
    key: &ServiceSigningKey,
    claims: SpaceDelegationClaims<'_>,
    now: u64,
) -> Result<String, ServiceAuthError> {
    if claims.issuer.is_empty()
        || claims.space_uri.is_empty()
        || claims.authority_did.is_empty()
        || claims.jti.is_empty()
    {
        return Err(ServiceAuthError::InvalidDelegationClaims);
    }
    let header = encode_json(&DelegationHeader {
        algorithm: "ES256K",
        kind: "atproto-space-delegation+jwt",
        key_id: "#atproto",
    })?;
    let claims = encode_json(&DelegationClaims {
        issuer: claims.issuer,
        subject: claims.space_uri,
        audience: &format!("{}{SPACE_HOST_AUDIENCE_FRAGMENT}", claims.authority_did),
        issued_at: now,
        expires_at: now.saturating_add(SPACE_DELEGATION_LIFETIME_SECONDS),
        jti: claims.jti,
    })?;
    let signed = format!("{header}.{claims}");
    let signature: Signature = key.signer()?.sign(signed.as_bytes());
    Ok(format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

pub struct SpaceDelegationClaims<'a> {
    pub issuer: &'a str,
    pub space_uri: &'a str,
    pub authority_did: &'a str,
    pub jti: &'a str,
}

fn encode_json(value: &impl Serialize) -> Result<String, ServiceAuthError> {
    serde_json::to_vec(value)
        .map(|value| URL_SAFE_NO_PAD.encode(value))
        .map_err(|_| ServiceAuthError::Serialization)
}

#[derive(Serialize)]
struct JwtHeader {
    #[serde(rename = "alg")]
    algorithm: &'static str,
    #[serde(rename = "typ")]
    kind: &'static str,
}

#[derive(Serialize)]
struct JwtClaims<'a> {
    #[serde(rename = "iss")]
    issuer: &'a str,
    #[serde(rename = "aud")]
    audience: &'a str,
    #[serde(rename = "exp")]
    expires_at: u64,
    lxm: &'a str,
}

#[derive(Serialize)]
struct DelegationHeader {
    #[serde(rename = "alg")]
    algorithm: &'static str,
    #[serde(rename = "typ")]
    kind: &'static str,
    #[serde(rename = "kid")]
    key_id: &'static str,
}

#[derive(Serialize)]
struct DelegationClaims<'a> {
    #[serde(rename = "iss")]
    issuer: &'a str,
    #[serde(rename = "sub")]
    subject: &'a str,
    #[serde(rename = "aud")]
    audience: &'a str,
    #[serde(rename = "iat")]
    issued_at: u64,
    #[serde(rename = "exp")]
    expires_at: u64,
    jti: &'a str,
}

#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use k256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
    use k256::elliptic_curve::scalar::IsHigh;
    use serde::Deserialize;

    use super::{
        SERVICE_JWT_LIFETIME_SECONDS, SPACE_DELEGATION_LIFETIME_SECONDS, ServiceSigningKey,
        SpaceDelegationClaims, mint_service_jwt, mint_space_delegation,
    };

    #[derive(Deserialize)]
    struct Claims {
        iss: String,
        aud: String,
        exp: u64,
        lxm: String,
    }

    #[test]
    fn mints_a_short_lived_method_bound_es256k_jwt() {
        let key = ServiceSigningKey::from_hex(
            "2fe8e925727a16e4970a5b0a556d9f8263b7c6b894885ca2857c8878938aa97b",
        )
        .unwrap();
        let token = mint_service_jwt(
            &key,
            "did:web:feedgen.example.test",
            "did:web:stratos.example.test",
            "zone.stratos.sync.subscribeRecords",
            1_000,
        )
        .unwrap();
        let segments = token.split('.').collect::<Vec<_>>();
        let [encoded_header, encoded_claims, encoded_signature] = segments.as_slice() else {
            panic!("service token has three segments");
        };
        let header = URL_SAFE_NO_PAD.decode(encoded_header).unwrap();
        assert_eq!(header, br#"{"alg":"ES256K","typ":"JWT"}"#);
        let claims: Claims =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded_claims).unwrap()).unwrap();
        assert_eq!(claims.iss, "did:web:feedgen.example.test");
        assert_eq!(claims.aud, "did:web:stratos.example.test");
        assert_eq!(claims.exp, 1_000 + SERVICE_JWT_LIFETIME_SECONDS);
        assert_eq!(claims.lxm, "zone.stratos.sync.subscribeRecords");
        let signature =
            Signature::from_slice(&URL_SAFE_NO_PAD.decode(encoded_signature).unwrap()).unwrap();
        let signing_key = k256::ecdsa::SigningKey::from_slice(&hex_bytes(
            "2fe8e925727a16e4970a5b0a556d9f8263b7c6b894885ca2857c8878938aa97b",
        ))
        .unwrap();
        VerifyingKey::from(&signing_key)
            .verify(
                format!("{encoded_header}.{encoded_claims}").as_bytes(),
                &signature,
            )
            .unwrap();
    }

    #[test]
    fn rejects_malformed_and_redacts_signing_keys() {
        assert!(ServiceSigningKey::from_hex("not-a-key").is_err());
        assert!(ServiceSigningKey::from_hex(&format!("é{}", "0".repeat(62))).is_err());
        let key = ServiceSigningKey::from_hex(&"00".repeat(32));
        assert!(key.is_err());
        let key = ServiceSigningKey::from_hex(&"11".repeat(32)).unwrap();
        assert_eq!(format!("{key:?}"), "ServiceSigningKey([REDACTED])");
    }

    #[test]
    fn mints_a_short_lived_single_use_space_delegation() {
        let key = ServiceSigningKey::from_hex(
            "2fe8e925727a16e4970a5b0a556d9f8263b7c6b894885ca2857c8878938aa97b",
        )
        .unwrap();
        let token = mint_space_delegation(
            &key,
            SpaceDelegationClaims {
                issuer: "did:web:feedgen.example.test",
                space_uri: "at:space/did:web:stratos.example.test/zone.stratos.space.feed/crew",
                authority_did: "did:web:stratos.example.test",
                jti: "nonce",
            },
            1_000,
        )
        .unwrap();
        let segments = token.split('.').collect::<Vec<_>>();
        let [encoded_header, encoded_claims, encoded_signature] = segments.as_slice() else {
            panic!("delegation token has three segments");
        };
        assert_eq!(
            URL_SAFE_NO_PAD.decode(encoded_header).unwrap(),
            br##"{"alg":"ES256K","typ":"atproto-space-delegation+jwt","kid":"#atproto"}"##
        );
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded_claims).unwrap()).unwrap();
        assert_eq!(claims["iat"], 1_000);
        assert_eq!(claims["exp"], 1_000 + SPACE_DELEGATION_LIFETIME_SECONDS);
        assert_eq!(claims["jti"], "nonce");
        let signature =
            Signature::from_slice(&URL_SAFE_NO_PAD.decode(encoded_signature).unwrap()).unwrap();
        let signing_key = k256::ecdsa::SigningKey::from_slice(&hex_bytes(
            "2fe8e925727a16e4970a5b0a556d9f8263b7c6b894885ca2857c8878938aa97b",
        ))
        .unwrap();
        VerifyingKey::from(&signing_key)
            .verify(
                format!("{encoded_header}.{encoded_claims}").as_bytes(),
                &signature,
            )
            .unwrap();
    }

    #[test]
    fn a_delegation_for_a_boundary_names_the_space_the_boundary_maps_to() {
        let key = ServiceSigningKey::from_hex(
            "2fe8e925727a16e4970a5b0a556d9f8263b7c6b894885ca2857c8878938aa97b",
        )
        .unwrap();
        let boundary = "did:web:stratos.example.test/crew";
        let space_uri = crate::credential_manager::boundary_to_space_uri(boundary).unwrap();
        let token = mint_space_delegation(
            &key,
            SpaceDelegationClaims {
                issuer: "did:web:feedgen.example.test",
                space_uri: &space_uri,
                authority_did: "did:web:stratos.example.test",
                jti: "nonce",
            },
            1_000,
        )
        .unwrap();
        let encoded_claims = token.split('.').nth(1).unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded_claims).unwrap()).unwrap();
        assert_eq!(
            claims["sub"],
            crate::credential_manager::boundary_to_space_uri(boundary).unwrap()
        );
        assert_eq!(
            claims["sub"],
            "at:space/did:web:stratos.example.test/zone.stratos.space.feed/crew"
        );
    }

    const PORT_AUTHORITY_DID: &str = "did:web:localhost%3A3100";
    const PORT_AUTHORITY_SPACE: &str =
        "at:space/did:web:localhost%3A3100/zone.stratos.space.feed/nerv";
    const TEST_ONLY_SIGNING_KEY: &str =
        "2fe8e925727a16e4970a5b0a556d9f8263b7c6b894885ca2857c8878938aa97b";
    const FIXED_DELEGATION_TOKEN: &str = "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJhdHByb3RvLXNwYWNlLWRlbGVnYXRpb24rand0Iiwia2lkIjoiI2F0cHJvdG8ifQ.eyJpc3MiOiJkaWQ6d2ViOmZlZWRnZW4uZXhhbXBsZS50ZXN0Iiwic3ViIjoiYXQ6c3BhY2UvZGlkOndlYjpsb2NhbGhvc3QlM0EzMTAwL3pvbmUuc3RyYXRvcy5zcGFjZS5mZWVkL25lcnYiLCJhdWQiOiJkaWQ6d2ViOmxvY2FsaG9zdCUzQTMxMDAjYXRwcm90b19wZHMiLCJpYXQiOjEwMDAsImV4cCI6MTA2MCwianRpIjoibm9uY2UifQ.dBaNYuvHe_V--AayTy6vQusFWf4r00gbbEvpJ4AeWRMdbpTrWDB-rdlEsvpczXAEmkcGkHlsAqhu67xtN11EJA";

    fn port_authority_delegation(key: &ServiceSigningKey) -> String {
        mint_space_delegation(
            key,
            SpaceDelegationClaims {
                issuer: "did:web:feedgen.example.test",
                space_uri: PORT_AUTHORITY_SPACE,
                authority_did: PORT_AUTHORITY_DID,
                jti: "nonce",
            },
            1_000,
        )
        .unwrap()
    }

    fn decoded_segment(token: &str, index: usize) -> serde_json::Value {
        let encoded = token.split('.').nth(index).unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
    }

    #[test]
    fn a_delegation_names_the_authority_host_service_as_its_audience() {
        let key = ServiceSigningKey::from_hex(TEST_ONLY_SIGNING_KEY).unwrap();
        let token = port_authority_delegation(&key);
        let claims = decoded_segment(&token, 1);
        assert_eq!(claims["aud"], "did:web:localhost%3A3100#atproto_pds");
        assert_eq!(claims["iss"], "did:web:feedgen.example.test");
        assert_eq!(claims["sub"], PORT_AUTHORITY_SPACE);
        assert_eq!(decoded_segment(&token, 0)["kid"], "#atproto");
    }

    #[test]
    fn a_delegation_for_fixed_inputs_is_byte_for_byte_stable() {
        let key = ServiceSigningKey::from_hex(TEST_ONLY_SIGNING_KEY).unwrap();
        assert_eq!(port_authority_delegation(&key), FIXED_DELEGATION_TOKEN);
    }

    #[test]
    fn rejects_invalid_space_delegation_claims_before_signing() {
        let key = ServiceSigningKey::from_hex(
            "2fe8e925727a16e4970a5b0a556d9f8263b7c6b894885ca2857c8878938aa97b",
        )
        .unwrap();
        assert_eq!(
            mint_space_delegation(
                &key,
                SpaceDelegationClaims {
                    issuer: "",
                    space_uri: "at:space/did:web:stratos.example.test/zone.stratos.space.feed/crew",
                    authority_did: "did:web:stratos.example.test",
                    jti: "nonce",
                },
                1_000,
            ),
            Err(super::ServiceAuthError::InvalidDelegationClaims)
        );
    }

    const MANY_DELEGATION_COUNT: u64 = 96;

    fn many_delegations() -> Vec<(String, String)> {
        use sha2::{Digest, Sha256};
        let names = [
            "spike", "faye", "jet", "ed", "rei", "asuka", "shinji", "misato",
        ];
        (0..MANY_DELEGATION_COUNT)
            .map(|index| {
                let seed = Sha256::digest(format!("cowboy-bebop-session-{index}"));
                let key_hex: String = seed.iter().map(|byte| format!("{byte:02x}")).collect();
                let key = ServiceSigningKey::from_hex(&key_hex).unwrap();
                let name = names[index as usize % names.len()];
                let space_uri = format!(
                    "at:space/did:web:stratos.example.test/zone.stratos.space.feed/{name}{index}"
                );
                let token = mint_space_delegation(
                    &key,
                    SpaceDelegationClaims {
                        issuer: &format!("did:web:{name}{index}.example.test"),
                        space_uri: &space_uri,
                        authority_did: "did:web:stratos.example.test",
                        jti: &format!("jti-{name}-{index}"),
                    },
                    1_000 + index * 37,
                )
                .unwrap();
                (key_hex, token)
            })
            .collect()
    }

    // Upstream verifies token JWTs without the allowance for high-S
    // signatures, so every delegation this minter can emit must be low-S.
    #[test]
    fn every_delegation_signature_is_in_low_s_form() {
        let delegations = many_delegations();
        assert_eq!(delegations.len() as u64, MANY_DELEGATION_COUNT);
        for (_, token) in &delegations {
            let encoded_signature = token.rsplit('.').next().unwrap();
            let signature =
                Signature::from_slice(&URL_SAFE_NO_PAD.decode(encoded_signature).unwrap()).unwrap();
            assert!(!bool::from(signature.s().is_high()));
            assert_eq!(signature.normalize_s(), signature);
        }
    }

    #[test]
    fn the_low_s_check_recognises_a_high_s_signature() {
        let key = ServiceSigningKey::from_hex(TEST_ONLY_SIGNING_KEY).unwrap();
        let token = port_authority_delegation(&key);
        let encoded_signature = token.rsplit('.').next().unwrap();
        let signature =
            Signature::from_slice(&URL_SAFE_NO_PAD.decode(encoded_signature).unwrap()).unwrap();
        let flipped = Signature::from_scalars(*signature.r(), -*signature.s()).unwrap();
        assert!(bool::from(flipped.s().is_high()));
        assert_ne!(flipped.normalize_s(), flipped);
    }

    fn hex_bytes(value: &str) -> [u8; 32] {
        let mut bytes = [0_u8; 32];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
        }
        bytes
    }
}

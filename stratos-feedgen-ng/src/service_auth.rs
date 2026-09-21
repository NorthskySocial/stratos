use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use k256::ecdsa::{Signature, SigningKey, signature::Signer};
use serde::Serialize;

pub const SERVICE_JWT_LIFETIME_SECONDS: u64 = 60;

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
    Serialization,
}

impl std::fmt::Display for ServiceAuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("could not mint service authentication token")
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

#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use k256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
    use serde::Deserialize;

    use super::{SERVICE_JWT_LIFETIME_SECONDS, ServiceSigningKey, mint_service_jwt};

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

    fn hex_bytes(value: &str) -> [u8; 32] {
        let mut bytes = [0_u8; 32];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
        }
        bytes
    }
}

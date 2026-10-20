use crate::space_host::{SpaceCredentialProof, SpaceHostError};

use crate::{
    identifier::Did,
    space_http_signature::{
        SpaceHttpSignatureError, SpaceHttpSignatureHeaders, SpaceHttpSignatureKey, validate_token,
    },
};

pub struct GrantedSpaceCredential {
    credential: String,
    key: SpaceHttpSignatureKey,
}

impl GrantedSpaceCredential {
    pub fn new(
        credential: String,
        key: SpaceHttpSignatureKey,
    ) -> Result<Self, SpaceHttpSignatureError> {
        validate_token(&credential)?;
        Ok(Self { credential, key })
    }

    pub fn key_id(&self) -> &str {
        self.key.key_id()
    }

    pub fn presentation_headers(
        &self,
        audience: &Did,
    ) -> Result<SpaceHttpSignatureHeaders, SpaceHttpSignatureError> {
        self.key.presentation_headers(&self.credential, audience)
    }
}

pub type HeldSpaceCredential = GrantedSpaceCredential;

#[async_trait::async_trait]
impl SpaceCredentialProof for GrantedSpaceCredential {
    async fn presentation_headers(
        &self,
        audience: &Did,
    ) -> Result<SpaceHttpSignatureHeaders, SpaceHostError> {
        GrantedSpaceCredential::presentation_headers(self, audience)
            .map_err(|_| SpaceHostError::Proof)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn grant_owned_keys_remain_distinct_and_reusable_with_their_credentials() {
        use super::{GrantedSpaceCredential, SpaceHttpSignatureKey};
        use crate::identifier::Did;

        let audience = Did::parse("did:plc:tokyo3").unwrap();
        let rei = GrantedSpaceCredential::new("rei".to_owned(), SpaceHttpSignatureKey::generate())
            .unwrap();
        let misato =
            GrantedSpaceCredential::new("misato".to_owned(), SpaceHttpSignatureKey::generate())
                .unwrap();
        assert_ne!(rei.key_id(), misato.key_id());
        let first = rei.presentation_headers(&audience).unwrap();
        assert_eq!(first.authorization(), "Atproto-Space rei");
        assert!(first == rei.presentation_headers(&audience).unwrap());
        assert_eq!(
            misato
                .presentation_headers(&audience)
                .unwrap()
                .authorization(),
            "Atproto-Space misato"
        );
        assert!(
            GrantedSpaceCredential::new(String::new(), SpaceHttpSignatureKey::generate()).is_err()
        );
        assert!(
            GrantedSpaceCredential::new(
                "rei\r\nmisato".to_owned(),
                SpaceHttpSignatureKey::generate()
            )
            .is_err()
        );
    }
}

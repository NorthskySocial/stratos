use k256::ecdsa::signature::Verifier;

const P256_MULTICODEC: u64 = 0x1200;
const SECP256K1_MULTICODEC: u64 = 0xe7;

pub(crate) enum DidVerificationKey {
    P256(p256::ecdsa::VerifyingKey),
    Secp256k1(k256::ecdsa::VerifyingKey),
}

impl DidVerificationKey {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        let encoded = value.strip_prefix("did:key:z")?;
        let bytes = bs58::decode(encoded).into_vec().ok()?;
        let (codec, key) = decode_multicodec(&bytes)?;
        match codec {
            P256_MULTICODEC => p256::ecdsa::VerifyingKey::from_sec1_bytes(key)
                .ok()
                .map(Self::P256),
            SECP256K1_MULTICODEC => k256::ecdsa::VerifyingKey::from_sec1_bytes(key)
                .ok()
                .map(Self::Secp256k1),
            _ => None,
        }
    }

    pub(crate) fn verifies_p256(&self, message: &[u8], signature: &[u8]) -> Option<bool> {
        match self {
            Self::P256(key) => p256::ecdsa::Signature::from_slice(signature)
                .ok()
                .map(|signature| key.verify(message, &signature).is_ok()),
            Self::Secp256k1(_) => Some(false),
        }
    }

    pub(crate) fn verifies_secp256k1(&self, message: &[u8], signature: &[u8]) -> Option<bool> {
        match self {
            Self::P256(_) => Some(false),
            Self::Secp256k1(key) => k256::ecdsa::Signature::from_slice(signature)
                .ok()
                .map(|signature| key.verify(message, &signature).is_ok()),
        }
    }

    pub(crate) fn verifies_any(&self, message: &[u8], signature: &[u8]) -> Option<bool> {
        match self {
            Self::P256(_) => self.verifies_p256(message, signature),
            Self::Secp256k1(_) => self.verifies_secp256k1(message, signature),
        }
    }
}

pub(crate) fn decode_multicodec(bytes: &[u8]) -> Option<(u64, &[u8])> {
    let mut value = 0_u64;
    for (index, byte) in bytes.iter().copied().enumerate() {
        let shift = index.checked_mul(7)?;
        if shift >= u64::BITS as usize {
            return None;
        }
        let payload = byte & 0x7f;
        if shift == 63 && (payload > 1 || byte & 0x80 != 0) {
            return None;
        }
        value |= u64::from(payload) << shift;
        if byte & 0x80 == 0 {
            if index > 0 && payload == 0 {
                return None;
            }
            return Some((value, &bytes[index + 1..]));
        }
    }
    None
}

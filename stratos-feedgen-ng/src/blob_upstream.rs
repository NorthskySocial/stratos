use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, StatusCode, redirect::Policy};
use url::Url;

use crate::{
    blob_cache::MAX_BLOB_BYTES,
    identifier::Did,
    service_auth::{ServiceSigningKey, mint_service_jwt},
};

const GET_BLOB_LXM: &str = "com.atproto.sync.getBlob";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Eq, PartialEq)]
pub enum BlobUpstreamError {
    InvalidConfiguration,
    InvalidRequest,
    Authentication,
    Unavailable,
    TooLarge,
}
impl std::fmt::Display for BlobUpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("blob upstream request failed")
    }
}
impl std::error::Error for BlobUpstreamError {}

#[async_trait]
pub trait BlobUpstream: Send + Sync {
    async fn get(&self, did: &str, cid: &str, now: u64) -> Result<Vec<u8>, BlobUpstreamError>;
}

pub struct HttpBlobUpstream {
    client: Client,
    service_url: Url,
    service_did: String,
    feedgen_did: String,
    signing_key: ServiceSigningKey,
}
impl HttpBlobUpstream {
    pub fn new(
        service_url: &str,
        service_did: String,
        feedgen_did: String,
        signing_key: ServiceSigningKey,
    ) -> Result<Self, BlobUpstreamError> {
        let service_url =
            Url::parse(service_url).map_err(|_| BlobUpstreamError::InvalidConfiguration)?;
        if !matches!(service_url.scheme(), "http" | "https")
            || service_url.host_str().is_none()
            || !service_url.username().is_empty()
            || service_url.password().is_some()
            || service_url.query().is_some()
            || service_url.fragment().is_some()
        {
            return Err(BlobUpstreamError::InvalidConfiguration);
        }
        Did::parse(service_did.clone()).map_err(|_| BlobUpstreamError::InvalidConfiguration)?;
        Did::parse(feedgen_did.clone()).map_err(|_| BlobUpstreamError::InvalidConfiguration)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(REQUEST_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| BlobUpstreamError::InvalidConfiguration)?;
        Ok(Self {
            client,
            service_url,
            service_did,
            feedgen_did,
            signing_key,
        })
    }
}
#[async_trait]
impl BlobUpstream for HttpBlobUpstream {
    async fn get(&self, did: &str, cid: &str, now: u64) -> Result<Vec<u8>, BlobUpstreamError> {
        Did::parse(did.to_owned()).map_err(|_| BlobUpstreamError::InvalidRequest)?;
        if cid.is_empty() || cid.len() > 256 || cid::Cid::try_from(cid).is_err() {
            return Err(BlobUpstreamError::InvalidRequest);
        }
        let mut url = self.service_url.clone();
        let base = url.path().trim_end_matches('/');
        url.set_path(&format!("{base}/xrpc/{GET_BLOB_LXM}"));
        url.query_pairs_mut()
            .append_pair("did", did)
            .append_pair("cid", cid);
        let token = mint_service_jwt(
            &self.signing_key,
            &self.feedgen_did,
            &self.service_did,
            GET_BLOB_LXM,
            now,
        )
        .map_err(|_| BlobUpstreamError::InvalidConfiguration)?;
        let mut response = self
            .client
            .get(url)
            .header("authorization", format!("Bearer {token}"))
            .send()
            .await
            .map_err(|_| BlobUpstreamError::Unavailable)?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(BlobUpstreamError::Authentication);
        }
        if !response.status().is_success() {
            return Err(BlobUpstreamError::Unavailable);
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_BLOB_BYTES as u64)
        {
            return Err(BlobUpstreamError::TooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| BlobUpstreamError::Unavailable)?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_BLOB_BYTES {
                return Err(BlobUpstreamError::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use crate::{blob_upstream::HttpBlobUpstream, service_auth::ServiceSigningKey};

    #[test]
    fn rejects_unsafe_or_ambiguous_service_urls() {
        let key = ServiceSigningKey::from_hex(&"07".repeat(32)).unwrap();
        for url in [
            "ftp://stratos.example.test",
            "https://user@stratos.example.test",
            "https://stratos.example.test/?route=blob",
        ] {
            assert!(
                HttpBlobUpstream::new(
                    url,
                    "did:web:stratos.example.test".to_owned(),
                    "did:web:feedgen.example.test".to_owned(),
                    key.clone(),
                )
                .is_err()
            );
        }
    }
}

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::{Mutex as AsyncMutex, watch};

use crate::{
    blob_cache::{BlobCache, BlobCacheError},
    blob_upstream::{BlobUpstream, BlobUpstreamError},
};

#[derive(Clone, Debug)]
pub enum BlobServiceError {
    Busy,
    TooLarge,
    Unavailable,
}
impl std::fmt::Display for BlobServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("blob service is unavailable")
    }
}
impl std::error::Error for BlobServiceError {}

pub struct BlobService {
    cache: Arc<Mutex<BlobCache>>,
    upstream: Arc<dyn BlobUpstream>,
    maximum_downloads: usize,
    in_flight: Arc<AsyncMutex<HashMap<String, watch::Sender<Option<BlobResult>>>>>,
}

type BlobResult = Result<Arc<[u8]>, BlobServiceError>;
impl BlobService {
    pub fn new(
        cache: Arc<Mutex<BlobCache>>,
        upstream: Arc<dyn BlobUpstream>,
        maximum_downloads: usize,
    ) -> Result<Self, BlobServiceError> {
        if maximum_downloads == 0 || maximum_downloads > 2 {
            return Err(BlobServiceError::Busy);
        }
        Ok(Self {
            cache,
            upstream,
            maximum_downloads,
            in_flight: Arc::new(AsyncMutex::new(HashMap::new())),
        })
    }
    pub fn cache(&self) -> Arc<Mutex<BlobCache>> {
        Arc::clone(&self.cache)
    }
    pub async fn get(&self, did: &str, cid: &str, now: u64) -> Result<Arc<[u8]>, BlobServiceError> {
        if let Some(bytes) = self
            .cache
            .lock()
            .expect("blob cache poisoned")
            .get(did, cid)
        {
            return Ok(bytes);
        }
        let key = format!("{did}\n{cid}");
        let receiver = {
            let mut in_flight = self.in_flight.lock().await;
            if let Some(sender) = in_flight.get(&key) {
                sender.subscribe()
            } else {
                if in_flight.len() >= self.maximum_downloads {
                    return Err(BlobServiceError::Busy);
                }
                let (sender, receiver) = watch::channel(None);
                in_flight.insert(key.clone(), sender.clone());
                let cache = Arc::clone(&self.cache);
                let upstream = Arc::clone(&self.upstream);
                let in_flight = Arc::clone(&self.in_flight);
                let did = did.to_owned();
                let cid = cid.to_owned();
                tokio::spawn(async move {
                    let result = download(cache, upstream, &did, &cid, now).await;
                    let _ = sender.send(Some(result));
                    in_flight.lock().await.remove(&key);
                });
                receiver
            }
        };
        receive_download(receiver).await
    }

    pub fn remove(&self, did: &str, cid: &str) {
        self.cache
            .lock()
            .expect("blob cache poisoned")
            .remove(did, cid);
    }
}

async fn receive_download(
    mut receiver: watch::Receiver<Option<BlobResult>>,
) -> Result<Arc<[u8]>, BlobServiceError> {
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result;
        }
        receiver
            .changed()
            .await
            .map_err(|_| BlobServiceError::Unavailable)?;
    }
}

async fn download(
    cache: Arc<Mutex<BlobCache>>,
    upstream: Arc<dyn BlobUpstream>,
    did: &str,
    cid: &str,
    now: u64,
) -> BlobResult {
    let bytes = upstream.get(did, cid, now).await.map_err(map_upstream)?;
    let mut cache = cache.lock().expect("blob cache poisoned");
    cache.put(did, cid, bytes).map_err(map_cache)?;
    cache.get(did, cid).ok_or(BlobServiceError::Unavailable)
}
fn map_upstream(error: BlobUpstreamError) -> BlobServiceError {
    match error {
        BlobUpstreamError::TooLarge => BlobServiceError::TooLarge,
        _ => BlobServiceError::Unavailable,
    }
}
fn map_cache(error: BlobCacheError) -> BlobServiceError {
    match error {
        BlobCacheError::TooLarge => BlobServiceError::TooLarge,
        _ => BlobServiceError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use async_trait::async_trait;
    use cid::Cid;
    use sha2::{Digest, Sha256};

    use crate::{
        blob_cache::BlobCache,
        blob_service::{BlobService, BlobServiceError},
        blob_upstream::{BlobUpstream, BlobUpstreamError},
    };

    struct StaticUpstream {
        bytes: Vec<u8>,
        calls: AtomicUsize,
        delay: Duration,
    }

    #[async_trait]
    impl BlobUpstream for StaticUpstream {
        async fn get(
            &self,
            _did: &str,
            _cid: &str,
            _now: u64,
        ) -> Result<Vec<u8>, BlobUpstreamError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(self.delay).await;
            Ok(self.bytes.clone())
        }
    }

    fn cid(bytes: &[u8]) -> String {
        Cid::new_v1(
            0x55,
            multihash::Multihash::<64>::wrap(0x12, &Sha256::digest(bytes)).unwrap(),
        )
        .to_string()
    }

    #[tokio::test]
    async fn caches_only_verified_upstream_content() {
        let bytes = b"see you space cowboy".to_vec();
        let upstream = Arc::new(StaticUpstream {
            bytes: bytes.clone(),
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
        });
        let service = BlobService::new(
            Arc::new(Mutex::new(
                BlobCache::new(1024, Duration::from_secs(60)).unwrap(),
            )),
            Arc::clone(&upstream) as Arc<dyn BlobUpstream>,
            1,
        )
        .unwrap();
        let cid = cid(&bytes);

        assert_eq!(
            &*service.get("did:plc:spike", &cid, 1).await.unwrap(),
            bytes
        );
        assert_eq!(
            &*service.get("did:plc:spike", &cid, 2).await.unwrap(),
            bytes
        );
        assert_eq!(upstream.calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn rejects_an_upstream_body_that_does_not_match_its_cid() {
        let upstream = Arc::new(StaticUpstream {
            bytes: b"mismatched".to_vec(),
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
        });
        let service = BlobService::new(
            Arc::new(Mutex::new(
                BlobCache::new(1024, Duration::from_secs(60)).unwrap(),
            )),
            upstream,
            1,
        )
        .unwrap();
        let requested = cid(b"expected");

        assert!(matches!(
            service.get("did:plc:spike", &requested, 1).await,
            Err(BlobServiceError::Unavailable)
        ));
        assert!(
            service
                .cache()
                .lock()
                .unwrap()
                .get("did:plc:spike", &requested)
                .is_none()
        );
    }

    #[tokio::test]
    async fn coalesces_same_blob_misses_without_consuming_another_download_slot() {
        let bytes = b"the real folk blues".to_vec();
        let upstream = Arc::new(StaticUpstream {
            bytes: bytes.clone(),
            calls: AtomicUsize::new(0),
            delay: Duration::from_millis(20),
        });
        let service = BlobService::new(
            Arc::new(Mutex::new(
                BlobCache::new(1024, Duration::from_secs(60)).unwrap(),
            )),
            Arc::clone(&upstream) as Arc<dyn BlobUpstream>,
            1,
        )
        .unwrap();
        let cid = cid(&bytes);

        let (first, second) = tokio::join!(
            service.get("did:plc:spike", &cid, 1),
            service.get("did:plc:spike", &cid, 1),
        );

        assert_eq!(&*first.unwrap(), bytes);
        assert_eq!(&*second.unwrap(), bytes);
        assert_eq!(upstream.calls.load(Ordering::Relaxed), 1);
    }
}

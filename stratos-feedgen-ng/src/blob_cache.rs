use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_BLOB_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;
const MAX_TTL: Duration = Duration::from_secs(300);
const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Eq, PartialEq)]
pub enum BlobCacheError {
    InvalidConfiguration,
    TooLarge,
    InvalidCid,
}
impl std::fmt::Display for BlobCacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("blob cache input is invalid")
    }
}
impl std::error::Error for BlobCacheError {}

struct Entry {
    bytes: Arc<[u8]>,
    expires_at: u64,
    last_access: u64,
}
/// A bounded in-memory cache for CID-verified blob content. Blob bytes never reach disk.
pub struct BlobCache {
    maximum_bytes: usize,
    ttl_seconds: u64,
    now: fn() -> u64,
    total_bytes: usize,
    access_counter: u64,
    entries: BTreeMap<String, Entry>,
}
impl BlobCache {
    pub fn new(maximum_bytes: usize, ttl: Duration) -> Result<Self, BlobCacheError> {
        Self::build(maximum_bytes, ttl, current_epoch_seconds)
    }
    #[cfg(test)]
    fn with_clock(
        maximum_bytes: usize,
        ttl: Duration,
        now: fn() -> u64,
    ) -> Result<Self, BlobCacheError> {
        Self::build(maximum_bytes, ttl, now)
    }
    fn build(
        maximum_bytes: usize,
        ttl: Duration,
        now: fn() -> u64,
    ) -> Result<Self, BlobCacheError> {
        if maximum_bytes == 0
            || maximum_bytes > MAX_CACHE_BYTES
            || ttl.is_zero()
            || ttl.as_secs() == 0
            || ttl > MAX_TTL
        {
            return Err(BlobCacheError::InvalidConfiguration);
        }
        Ok(Self {
            maximum_bytes,
            ttl_seconds: ttl.as_secs(),
            now,
            total_bytes: 0,
            access_counter: 0,
            entries: BTreeMap::new(),
        })
    }
    pub fn get(&mut self, did: &str, cid: &str) -> Option<Arc<[u8]>> {
        let now = (self.now)();
        self.remove_expired(now);
        let key = cache_key(did, cid);
        self.access_counter = self.access_counter.wrapping_add(1);
        let entry = self.entries.get_mut(&key)?;
        entry.last_access = self.access_counter;
        Some(Arc::clone(&entry.bytes))
    }
    pub fn put(&mut self, did: &str, cid: &str, bytes: Vec<u8>) -> Result<(), BlobCacheError> {
        if bytes.len() > MAX_BLOB_BYTES || bytes.len() > self.maximum_bytes {
            return Err(BlobCacheError::TooLarge);
        }
        verify_blob_cid(&bytes, cid)?;
        let now = (self.now)();
        self.remove_expired(now);
        let key = cache_key(did, cid);
        if let Some(previous) = self.entries.remove(&key) {
            self.total_bytes -= previous.bytes.len();
        }
        while self.entries.len() >= MAX_ENTRIES
            || self.total_bytes.saturating_add(bytes.len()) > self.maximum_bytes
        {
            self.remove_oldest()?;
        }
        self.access_counter = self.access_counter.wrapping_add(1);
        self.total_bytes += bytes.len();
        self.entries.insert(
            key,
            Entry {
                bytes: Arc::from(bytes),
                expires_at: now.saturating_add(self.ttl_seconds),
                last_access: self.access_counter,
            },
        );
        Ok(())
    }
    pub fn remove(&mut self, did: &str, cid: &str) {
        if let Some(entry) = self.entries.remove(&cache_key(did, cid)) {
            self.total_bytes -= entry.bytes.len();
        }
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.total_bytes = 0;
    }
    pub fn sweep_expired(&mut self) {
        self.remove_expired((self.now)());
    }
    fn remove_expired(&mut self, now: u64) {
        let keys = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.expires_at <= now)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(entry) = self.entries.remove(&key) {
                self.total_bytes -= entry.bytes.len();
            }
        }
    }
    fn remove_oldest(&mut self) -> Result<(), BlobCacheError> {
        let key = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_access)
            .map(|(key, _)| key.clone())
            .ok_or(BlobCacheError::TooLarge)?;
        let entry = self
            .entries
            .remove(&key)
            .expect("oldest cache entry exists");
        self.total_bytes -= entry.bytes.len();
        Ok(())
    }
}

pub struct BlobCacheSweeper {
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl BlobCacheSweeper {
    pub fn start(cache: Arc<std::sync::Mutex<BlobCache>>) -> Self {
        let (shutdown, mut receiver) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(SWEEP_INTERVAL) => {
                        cache.lock().expect("blob cache poisoned").sweep_expired();
                    }
                    changed = receiver.changed() => {
                        if changed.is_err() || *receiver.borrow() { return; }
                    }
                }
            }
        });
        Self {
            shutdown,
            task: tokio::sync::Mutex::new(Some(task)),
        }
    }

    pub async fn stop(&self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}
fn cache_key(did: &str, cid: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(did);
    hash.update([0]);
    hash.update(cid);
    format!("{:x}", hash.finalize())
}
pub fn verify_blob_cid(bytes: &[u8], cid: &str) -> Result<(), BlobCacheError> {
    let cid = cid::Cid::try_from(cid).map_err(|_| BlobCacheError::InvalidCid)?;
    if cid.codec() != 0x55
        || cid.hash().code() != 0x12
        || cid.hash().size() != 32
        || cid.hash().digest() != &Sha256::digest(bytes)[..]
    {
        return Err(BlobCacheError::InvalidCid);
    }
    Ok(())
}
fn current_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{BlobCache, BlobCacheError};
    use cid::Cid;
    use sha2::{Digest, Sha256};
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };
    static NOW: AtomicU64 = AtomicU64::new(1000);
    fn now() -> u64 {
        NOW.load(Ordering::Relaxed)
    }
    fn cid(bytes: &[u8]) -> String {
        Cid::new_v1(
            0x55,
            multihash::Multihash::<64>::wrap(0x12, &Sha256::digest(bytes)).unwrap(),
        )
        .to_string()
    }
    #[test]
    fn evicts_lru_without_copying_cached_blob() {
        let mut cache = BlobCache::with_clock(7, Duration::from_secs(60), now).unwrap();
        let first = b"one".to_vec();
        let second = b"two".to_vec();
        let third = b"four".to_vec();
        let a = cid(&first);
        let b = cid(&second);
        let c = cid(&third);
        cache.put("did:plc:spike", &a, first).unwrap();
        cache.put("did:plc:spike", &b, second).unwrap();
        let held = cache.get("did:plc:spike", &a).unwrap();
        cache.put("did:plc:spike", &c, third).unwrap();
        assert_eq!(&*held, b"one");
        assert!(cache.get("did:plc:spike", &a).is_some());
        assert!(cache.get("did:plc:spike", &b).is_none());
    }
    #[test]
    fn expires_and_removes_bytes() {
        NOW.store(1000, Ordering::Relaxed);
        let bytes = b"one".to_vec();
        let cid = cid(&bytes);
        let mut cache = BlobCache::with_clock(6, Duration::from_secs(5), now).unwrap();
        cache.put("did:plc:spike", &cid, bytes).unwrap();
        NOW.store(1005, Ordering::Relaxed);
        cache.sweep_expired();
        assert!(cache.get("did:plc:spike", &cid).is_none());
    }
    #[test]
    fn rejects_unverified_and_unbounded_config() {
        assert!(matches!(
            BlobCache::new(super::MAX_CACHE_BYTES + 1, Duration::from_secs(1)),
            Err(BlobCacheError::InvalidConfiguration)
        ));
        let mut cache = BlobCache::new(3, Duration::from_secs(1)).unwrap();
        assert_eq!(
            cache.put("did:plc:spike", "bafyreia", b"four".to_vec()),
            Err(BlobCacheError::TooLarge)
        );
        assert_eq!(
            cache.put("did:plc:spike", "bafyreia", b"one".to_vec()),
            Err(BlobCacheError::InvalidCid)
        );
    }
}

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use tokio::sync::Notify;

use crate::{
    credential_issuer::{CredentialExpiry, CredentialMintError, SpaceCredentialIssuer},
    identifier::RecordUri,
    space_credential::{DpopKey, HeldSpaceCredential},
};

const MAX_CREDENTIALS: usize = 128;
const REFRESH_MARGIN_SECONDS: u64 = 5 * 60;
const SPACE_TYPE: &str = "zone.stratos.space.feed";
const POST_COLLECTION: &str = "zone.stratos.feed.post";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialManagerError {
    InvalidBoundary,
    Capacity,
    Invalidated,
    Mint(CredentialMintError),
}

impl std::fmt::Display for CredentialManagerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBoundary => formatter.write_str("credential boundary is invalid"),
            Self::Capacity => formatter.write_str("credential cache capacity exceeded"),
            Self::Invalidated => formatter.write_str("credential cache was invalidated"),
            Self::Mint(error) => write!(formatter, "credential mint failed: {error}"),
        }
    }
}

impl std::error::Error for CredentialManagerError {}

pub struct SpaceCredentialManager {
    issuer: Arc<dyn SpaceCredentialIssuer>,
    key: Arc<DpopKey>,
    now: fn() -> u64,
    state: Mutex<ManagerState>,
}

struct ManagerState {
    generation: u64,
    credentials: BTreeMap<String, CachedCredential>,
    in_flight: BTreeMap<String, Arc<CredentialFlight>>,
}

struct CachedCredential {
    credential: Arc<HeldSpaceCredential>,
    expiry: CredentialExpiry,
}

struct CredentialFlight {
    generation: u64,
    notify: Notify,
    result: Mutex<Option<Result<Arc<HeldSpaceCredential>, CredentialManagerError>>>,
}

impl SpaceCredentialManager {
    pub fn new(issuer: Arc<dyn SpaceCredentialIssuer>) -> Self {
        Self::with_clock(issuer, current_epoch_seconds)
    }

    pub fn with_clock(issuer: Arc<dyn SpaceCredentialIssuer>, now: fn() -> u64) -> Self {
        Self {
            issuer,
            key: Arc::new(DpopKey::generate()),
            now,
            state: Mutex::new(ManagerState {
                generation: 0,
                credentials: BTreeMap::new(),
                in_flight: BTreeMap::new(),
            }),
        }
    }

    pub async fn get(
        &self,
        boundary: &str,
    ) -> Result<Arc<HeldSpaceCredential>, CredentialManagerError> {
        let space_uri = boundary_to_space_uri(boundary)?;
        let now = (self.now)();
        let (flight, owner) = {
            let mut state = self.state.lock().expect("credential manager poisoned");
            if let Some(cached) = state.credentials.get(boundary)
                && cached.expiry.as_epoch_seconds().saturating_sub(now) > REFRESH_MARGIN_SECONDS
            {
                return Ok(Arc::clone(&cached.credential));
            }
            if let Some(flight) = state.in_flight.get(boundary) {
                (Arc::clone(flight), false)
            } else {
                if state.credentials.len() >= MAX_CREDENTIALS
                    && !state.credentials.contains_key(boundary)
                {
                    return Err(CredentialManagerError::Capacity);
                }
                let flight = Arc::new(CredentialFlight {
                    generation: state.generation,
                    notify: Notify::new(),
                    result: Mutex::new(None),
                });
                state
                    .in_flight
                    .insert(boundary.to_owned(), Arc::clone(&flight));
                (flight, true)
            }
        };
        if owner {
            let result = self.mint(&space_uri, now).await;
            return self.complete(boundary, &flight, result);
        }
        wait_for_flight(flight).await
    }

    pub fn clear(&self) {
        let mut state = self.state.lock().expect("credential manager poisoned");
        state.credentials.clear();
        state.generation = state.generation.wrapping_add(1);
        for flight in state.in_flight.values() {
            *flight.result.lock().expect("credential flight poisoned") =
                Some(Err(CredentialManagerError::Invalidated));
            flight.notify.notify_waiters();
        }
    }

    async fn mint(
        &self,
        space_uri: &str,
        now: u64,
    ) -> Result<(Arc<HeldSpaceCredential>, CredentialExpiry), CredentialManagerError> {
        let issued = self
            .issuer
            .mint(space_uri, &self.key, now)
            .await
            .map_err(CredentialManagerError::Mint)?;
        HeldSpaceCredential::new(issued.credential, Arc::clone(&self.key), self.now)
            .map(|credential| (Arc::new(credential), issued.expires_at))
            .map_err(|_| CredentialManagerError::Mint(CredentialMintError::InvalidResponse))
    }

    fn complete(
        &self,
        boundary: &str,
        flight: &Arc<CredentialFlight>,
        result: Result<(Arc<HeldSpaceCredential>, CredentialExpiry), CredentialManagerError>,
    ) -> Result<Arc<HeldSpaceCredential>, CredentialManagerError> {
        let mut state = self.state.lock().expect("credential manager poisoned");
        let result = if flight.generation != state.generation {
            Err(CredentialManagerError::Invalidated)
        } else {
            result.map(|(credential, expiry)| {
                state.credentials.insert(
                    boundary.to_owned(),
                    CachedCredential {
                        credential: Arc::clone(&credential),
                        expiry,
                    },
                );
                credential
            })
        };
        state.in_flight.remove(boundary);
        let mut flight_result = flight.result.lock().expect("credential flight poisoned");
        if flight_result.is_none() {
            *flight_result = Some(result.clone());
        }
        let result = flight_result.clone().expect("credential flight completed");
        drop(flight_result);
        flight.notify.notify_waiters();
        result
    }
}

async fn wait_for_flight(
    flight: Arc<CredentialFlight>,
) -> Result<Arc<HeldSpaceCredential>, CredentialManagerError> {
    loop {
        if let Some(result) = flight
            .result
            .lock()
            .expect("credential flight poisoned")
            .clone()
        {
            return result;
        }
        flight.notify.notified().await;
    }
}

pub(crate) fn boundary_to_space_uri(boundary: &str) -> Result<String, CredentialManagerError> {
    let Some((authority, key)) = boundary.split_once('/') else {
        return Err(CredentialManagerError::InvalidBoundary);
    };
    let probe =
        format!("at://{authority}/space/{SPACE_TYPE}/{key}/{authority}/{POST_COLLECTION}/probe");
    if !matches!(
        RecordUri::parse_space_record(&probe),
        Ok(RecordUri::Space { .. })
    ) {
        return Err(CredentialManagerError::InvalidBoundary);
    }
    Ok(format!("at://{authority}/space/{SPACE_TYPE}/{key}"))
}

fn current_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use async_trait::async_trait;

    use crate::{
        credential_issuer::{
            CredentialExpiry, CredentialMintError, IssuedSpaceCredential, SpaceCredentialIssuer,
        },
        space_credential::DpopKey,
    };

    use super::{CredentialManagerError, SpaceCredentialManager, boundary_to_space_uri};

    struct CountingIssuer(AtomicUsize);

    #[async_trait]
    impl SpaceCredentialIssuer for CountingIssuer {
        async fn mint(
            &self,
            _: &str,
            _: &DpopKey,
            _: u64,
        ) -> Result<IssuedSpaceCredential, CredentialMintError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(5)).await;
            Ok(IssuedSpaceCredential {
                credential: "header.payload.signature".to_owned(),
                expires_at: CredentialExpiry::from_epoch_seconds(10_000),
            })
        }
    }

    fn fixed_now() -> u64 {
        1_000
    }

    #[test]
    fn derives_only_a_valid_authority_owned_feed_space() {
        assert_eq!(
            boundary_to_space_uri("did:web:stratos.example.test/crew").unwrap(),
            "at://did:web:stratos.example.test/space/zone.stratos.space.feed/crew"
        );
        assert_eq!(
            boundary_to_space_uri("not-a-boundary"),
            Err(CredentialManagerError::InvalidBoundary)
        );
    }

    #[tokio::test]
    async fn reuses_a_live_credential_and_coalesces_concurrent_mints() {
        let issuer = Arc::new(CountingIssuer(AtomicUsize::new(0)));
        let manager = Arc::new(SpaceCredentialManager::with_clock(
            issuer.clone(),
            fixed_now,
        ));
        let first = {
            let manager = Arc::clone(&manager);
            tokio::spawn(async move {
                manager
                    .get("did:web:stratos.example.test/crew")
                    .await
                    .unwrap()
            })
        };
        let second = {
            let manager = Arc::clone(&manager);
            tokio::spawn(async move {
                manager
                    .get("did:web:stratos.example.test/crew")
                    .await
                    .unwrap()
            })
        };
        let (first, second) = tokio::join!(first, second);
        assert!(Arc::ptr_eq(&first.unwrap(), &second.unwrap()));
        assert_eq!(issuer.0.load(Ordering::SeqCst), 1);
        manager
            .get("did:web:stratos.example.test/crew")
            .await
            .unwrap();
        assert_eq!(issuer.0.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn clearing_credentials_forces_a_new_mint() {
        let issuer = Arc::new(CountingIssuer(AtomicUsize::new(0)));
        let manager = SpaceCredentialManager::with_clock(issuer.clone(), fixed_now);
        manager
            .get("did:web:stratos.example.test/crew")
            .await
            .unwrap();
        manager.clear();
        manager
            .get("did:web:stratos.example.test/crew")
            .await
            .unwrap();
        assert_eq!(issuer.0.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn clearing_invalidates_a_pending_mint() {
        let issuer = Arc::new(CountingIssuer(AtomicUsize::new(0)));
        let manager = Arc::new(SpaceCredentialManager::with_clock(issuer, fixed_now));
        let pending = {
            let manager = Arc::clone(&manager);
            tokio::spawn(async move { manager.get("did:web:stratos.example.test/crew").await })
        };
        tokio::time::sleep(Duration::from_millis(1)).await;
        manager.clear();
        assert!(matches!(
            pending.await.unwrap(),
            Err(CredentialManagerError::Invalidated)
        ));
    }
}

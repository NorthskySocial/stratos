use std::collections::BTreeMap;

use crate::identifier::Did;

pub const DEFAULT_AUTHORIZATION_BYTES: usize = 8 * 1024 * 1024;
const AUTHORIZATION_ENTRY_OVERHEAD: usize = 256;
const BOUNDARY_ENTRY_OVERHEAD: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewerAuthorization {
    pub did: String,
    pub boundaries: Vec<String>,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthorizationError {
    InvalidViewer,
    EmptyBoundary,
    Expired,
    CapacityExceeded,
}

impl std::fmt::Display for AuthorizationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidViewer => "viewer DID is invalid",
            Self::EmptyBoundary => "viewer authorization contains an empty boundary",
            Self::Expired => "viewer authorization is already expired",
            Self::CapacityExceeded => "viewer authorization capacity is exhausted",
        })
    }
}

impl std::error::Error for AuthorizationError {}

pub struct ViewerAuthorizations {
    entries: BTreeMap<String, ViewerAuthorization>,
    bytes: usize,
    capacity: usize,
    max_entries: usize,
}

impl ViewerAuthorizations {
    pub fn new(capacity: usize) -> Self {
        Self::with_limits(capacity, (capacity / AUTHORIZATION_ENTRY_OVERHEAD).max(1))
    }

    pub fn with_limits(capacity: usize, max_entries: usize) -> Self {
        Self {
            entries: BTreeMap::new(),
            bytes: 0,
            capacity,
            max_entries,
        }
    }

    pub fn replace(
        &mut self,
        mut authorization: ViewerAuthorization,
        now: u64,
    ) -> Result<(), AuthorizationError> {
        self.purge_expired(now);
        Did::parse(authorization.did.clone()).map_err(|_| AuthorizationError::InvalidViewer)?;
        authorization.boundaries.sort_unstable();
        authorization.boundaries.dedup();
        if authorization.boundaries.is_empty() {
            self.revoke(&authorization.did);
            return Ok(());
        }
        if authorization.expires_at <= now {
            self.revoke(&authorization.did);
            return Err(AuthorizationError::Expired);
        }
        if authorization
            .boundaries
            .iter()
            .any(|boundary| boundary.is_empty())
        {
            self.revoke(&authorization.did);
            return Err(AuthorizationError::EmptyBoundary);
        }
        let new_bytes = authorization_bytes(&authorization);
        let old_bytes = self
            .entries
            .get(&authorization.did)
            .map(authorization_bytes)
            .unwrap_or_default();
        let next_bytes = self.bytes - old_bytes + new_bytes;
        if next_bytes > self.capacity || (old_bytes == 0 && self.entries.len() >= self.max_entries)
        {
            self.revoke(&authorization.did);
            return Err(AuthorizationError::CapacityExceeded);
        }
        self.entries
            .insert(authorization.did.clone(), authorization);
        self.bytes = next_bytes;
        Ok(())
    }

    pub fn current(&mut self, did: &str, now: u64) -> Option<ViewerAuthorization> {
        let authorization = self.entries.get(did)?.clone();
        if authorization.expires_at > now {
            return Some(authorization);
        }
        self.revoke(did);
        None
    }

    pub fn revoke(&mut self, did: &str) -> Option<ViewerAuthorization> {
        let authorization = self.entries.remove(did)?;
        self.bytes -= authorization_bytes(&authorization);
        Some(authorization)
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    fn purge_expired(&mut self, now: u64) {
        let expired = self
            .entries
            .iter()
            .filter(|(_, authorization)| authorization.expires_at <= now)
            .map(|(did, _)| did.clone())
            .collect::<Vec<_>>();
        for did in expired {
            self.revoke(&did);
        }
    }
}

fn authorization_bytes(authorization: &ViewerAuthorization) -> usize {
    AUTHORIZATION_ENTRY_OVERHEAD
        + authorization.did.capacity()
        + authorization
            .boundaries
            .iter()
            .map(|boundary| boundary.capacity() + BOUNDARY_ENTRY_OVERHEAD)
            .sum::<usize>()
}

#[cfg(test)]
mod tests {
    use super::{AuthorizationError, ViewerAuthorization, ViewerAuthorizations};

    fn authorization(did: &str, boundaries: Vec<&str>, expires_at: u64) -> ViewerAuthorization {
        ViewerAuthorization {
            did: did.to_owned(),
            boundaries: boundaries.into_iter().map(str::to_owned).collect(),
            expires_at,
        }
    }

    #[test]
    fn normalizes_and_expires_viewer_authorizations() {
        let mut authorizations = ViewerAuthorizations::new(1_024);
        authorizations
            .replace(
                authorization("did:plc:faye", vec!["red-tail", "bebop", "bebop"], 10),
                1,
            )
            .unwrap();

        assert_eq!(
            authorizations
                .current("did:plc:faye", 2)
                .unwrap()
                .boundaries,
            ["bebop", "red-tail"]
        );
        assert!(authorizations.current("did:plc:faye", 10).is_none());
        assert_eq!(authorizations.bytes(), 0);
    }

    #[test]
    fn rejects_invalid_or_unbounded_authorizations_without_replacing_other_viewers() {
        let mut authorizations = ViewerAuthorizations::new(400);
        let existing = authorization("did:plc:faye", vec!["bebop"], 10);
        authorizations.replace(existing.clone(), 1).unwrap();
        assert_eq!(
            authorizations.replace(authorization("not-a-did", vec!["bebop"], 10), 1),
            Err(AuthorizationError::InvalidViewer)
        );
        assert_eq!(
            authorizations.replace(
                authorization("did:plc:spike", vec!["a-very-long-boundary"], 10),
                1
            ),
            Err(AuthorizationError::CapacityExceeded)
        );
        assert_eq!(authorizations.current("did:plc:faye", 2), Some(existing));
    }

    #[test]
    fn rejects_an_unbounded_replacement_by_revoking_the_existing_lease() {
        let mut authorizations = ViewerAuthorizations::new(310);
        authorizations
            .replace(authorization("did:plc:faye", vec!["bebop"], 10), 1)
            .unwrap();

        assert_eq!(
            authorizations.replace(
                authorization("did:plc:faye", vec!["a-very-long-boundary"], 10),
                1,
            ),
            Err(AuthorizationError::CapacityExceeded)
        );
        assert!(authorizations.current("did:plc:faye", 2).is_none());
    }

    #[test]
    fn sweeps_expired_entries_before_enforcing_capacity() {
        let mut authorizations = ViewerAuthorizations::new(400);
        authorizations
            .replace(authorization("did:plc:faye", vec!["bebop"], 10), 1)
            .unwrap();

        authorizations
            .replace(authorization("did:plc:spike", vec!["bebop"], 20), 11)
            .unwrap();

        assert!(authorizations.current("did:plc:faye", 11).is_none());
        assert!(authorizations.current("did:plc:spike", 11).is_some());
    }

    #[test]
    fn bounds_many_small_authorizations_by_entry_count() {
        let mut authorizations = ViewerAuthorizations::with_limits(10_000, 2);
        authorizations
            .replace(authorization("did:plc:faye", vec!["bebop"], 10), 1)
            .unwrap();
        authorizations
            .replace(authorization("did:plc:spike", vec!["bebop"], 10), 1)
            .unwrap();

        assert_eq!(
            authorizations.replace(authorization("did:plc:jet", vec!["bebop"], 10), 1),
            Err(AuthorizationError::CapacityExceeded)
        );
    }

    #[test]
    fn empty_authority_boundaries_revoke_the_existing_lease() {
        let mut authorizations = ViewerAuthorizations::new(1_024);
        authorizations
            .replace(authorization("did:plc:faye", vec!["bebop"], 10), 1)
            .unwrap();

        authorizations
            .replace(authorization("did:plc:faye", Vec::new(), 20), 2)
            .unwrap();

        assert!(authorizations.current("did:plc:faye", 2).is_none());
    }
}

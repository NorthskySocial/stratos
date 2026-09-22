use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use async_trait::async_trait;

use crate::{
    credential_manager::{CredentialManagerError, SpaceCredentialManager, boundary_to_space_uri},
    space_credential::HeldSpaceCredential,
    space_membership::{
        MAX_MEMBERSHIP_PAGE, RepoCustody, SpaceMembershipError, SpaceMembershipPage,
        SpaceRepoMember,
    },
    store::{EncryptedStore, PdsSpaceMember, StoreError},
};

const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = MAX_MEMBERSHIP_PAGE / PAGE_SIZE;

#[async_trait]
pub trait SpaceMembershipClient: Send + Sync {
    async fn list(
        &self,
        space_uri: &str,
        credential: &HeldSpaceCredential,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<SpaceMembershipPage, SpaceMembershipError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PdsPollTarget {
    pub space_uri: String,
    pub boundary: String,
    pub did: String,
    pub host: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MembershipReconciliation {
    pub pds_members: u16,
    pub targets: Vec<PdsPollTarget>,
}

#[derive(Debug)]
pub enum MembershipReconciliationError {
    Credential(CredentialManagerError),
    Membership(SpaceMembershipError),
    DuplicateMember,
    CursorStalled,
    PageLimit,
    Store(StoreError),
}

impl std::fmt::Display for MembershipReconciliationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("space membership reconciliation failed")
    }
}

impl std::error::Error for MembershipReconciliationError {}

pub struct MembershipReconciler {
    client: Arc<dyn SpaceMembershipClient>,
    credentials: Arc<SpaceCredentialManager>,
}

impl MembershipReconciler {
    pub fn new(
        client: Arc<dyn SpaceMembershipClient>,
        credentials: Arc<SpaceCredentialManager>,
    ) -> Self {
        Self {
            client,
            credentials,
        }
    }

    /// Completes authority enumeration before replacing the durable PDS
    /// membership baseline. Failed or partial pages preserve the old baseline.
    pub async fn reconcile(
        &self,
        store: &mut EncryptedStore,
        boundary: &str,
        reconciled_at: &str,
    ) -> Result<MembershipReconciliation, MembershipReconciliationError> {
        let space_uri =
            boundary_to_space_uri(boundary).map_err(MembershipReconciliationError::Credential)?;
        let credential = self
            .credentials
            .get(boundary)
            .await
            .map_err(MembershipReconciliationError::Credential)?;
        let members = self.enumerate(&space_uri, credential.as_ref()).await?;
        let pds_members = members
            .values()
            .filter(|member| member.custody == RepoCustody::Pds)
            .collect::<Vec<_>>();
        let baseline = pds_members
            .iter()
            .map(|member| PdsSpaceMember {
                did: member.did.clone(),
            })
            .collect();
        store
            .replace_pds_space_members(boundary, baseline, reconciled_at)
            .map_err(MembershipReconciliationError::Store)?;
        let targets = pds_members
            .into_iter()
            .filter_map(|member| {
                member.host.as_ref().map(|host| PdsPollTarget {
                    space_uri: space_uri.clone(),
                    boundary: boundary.to_owned(),
                    did: member.did.clone(),
                    host: host.clone(),
                })
            })
            .collect();
        Ok(MembershipReconciliation {
            pds_members: u16::try_from(
                members
                    .values()
                    .filter(|member| member.custody == RepoCustody::Pds)
                    .count(),
            )
            .expect("membership cap fits u16"),
            targets,
        })
    }

    async fn enumerate(
        &self,
        space_uri: &str,
        credential: &HeldSpaceCredential,
    ) -> Result<BTreeMap<String, SpaceRepoMember>, MembershipReconciliationError> {
        let mut cursor = None;
        let mut cursors = BTreeSet::new();
        let mut members = BTreeMap::new();
        for _ in 0..MAX_PAGES {
            let page = self
                .client
                .list(space_uri, credential, cursor.as_deref(), PAGE_SIZE)
                .await
                .map_err(MembershipReconciliationError::Membership)?;
            for member in page.members {
                if members.len() >= MAX_MEMBERSHIP_PAGE || members.contains_key(&member.did) {
                    return Err(MembershipReconciliationError::DuplicateMember);
                }
                members.insert(member.did.clone(), member);
            }
            let Some(next_cursor) = page.next_cursor else {
                return Ok(members);
            };
            if !cursors.insert(next_cursor.clone()) {
                return Err(MembershipReconciliationError::CursorStalled);
            }
            cursor = Some(next_cursor);
        }
        Err(MembershipReconciliationError::PageLimit)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    use async_trait::async_trait;

    use crate::{
        credential_issuer::{
            CredentialExpiry, CredentialMintError, IssuedSpaceCredential, SpaceCredentialIssuer,
        },
        space_credential::DpopKey,
        space_membership::{
            RepoCustody, SpaceMembershipError, SpaceMembershipPage, SpaceRepoMember,
        },
        store::{EncryptedStore, PdsSpaceMember, StorageKey},
    };

    use super::{MembershipReconciler, MembershipReconciliationError, SpaceMembershipClient};

    const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const NOW: &str = "2026-09-22T00:00:00.000Z";

    struct StaticIssuer;

    #[async_trait]
    impl SpaceCredentialIssuer for StaticIssuer {
        async fn mint(
            &self,
            _: &str,
            _: &DpopKey,
            _: u64,
        ) -> Result<IssuedSpaceCredential, CredentialMintError> {
            Ok(IssuedSpaceCredential {
                credential: "header.payload.signature".to_owned(),
                expires_at: CredentialExpiry::from_epoch_seconds(10_000),
            })
        }
    }

    struct Pages(Mutex<VecDeque<Result<SpaceMembershipPage, SpaceMembershipError>>>);

    #[async_trait]
    impl SpaceMembershipClient for Pages {
        async fn list(
            &self,
            _: &str,
            _: &crate::space_credential::HeldSpaceCredential,
            _: Option<&str>,
            _: usize,
        ) -> Result<SpaceMembershipPage, SpaceMembershipError> {
            self.0
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Err(SpaceMembershipError::Unavailable))
        }
    }

    fn reconciler(
        pages: Vec<Result<SpaceMembershipPage, SpaceMembershipError>>,
    ) -> MembershipReconciler {
        let credentials = Arc::new(
            crate::credential_manager::SpaceCredentialManager::with_clock(
                Arc::new(StaticIssuer),
                || 1_000,
            ),
        );
        MembershipReconciler::new(Arc::new(Pages(Mutex::new(pages.into()))), credentials)
    }

    fn member(did: &str, custody: RepoCustody, host: Option<&str>) -> SpaceRepoMember {
        SpaceRepoMember {
            did: did.to_owned(),
            custody,
            host: host.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn replaces_the_baseline_only_after_complete_authority_enumeration() {
        let reconciler = reconciler(vec![
            Ok(SpaceMembershipPage {
                members: vec![member(
                    "did:plc:faye",
                    RepoCustody::Pds,
                    Some("https://faye.example.test/"),
                )],
                next_cursor: Some("two".to_owned()),
            }),
            Ok(SpaceMembershipPage {
                members: vec![
                    member("did:plc:spike", RepoCustody::Pds, None),
                    member("did:plc:jet", RepoCustody::Stratos, None),
                ],
                next_cursor: None,
            }),
        ]);
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();

        let result = reconciler
            .reconcile(&mut store, BOUNDARY, NOW)
            .await
            .unwrap();

        assert_eq!(result.pds_members, 2);
        assert_eq!(result.targets.len(), 1);
        assert!(
            store
                .is_current_pds_space_member(BOUNDARY, "did:plc:faye")
                .unwrap()
        );
        assert!(
            store
                .is_current_pds_space_member(BOUNDARY, "did:plc:spike")
                .unwrap()
        );
        assert!(
            !store
                .is_current_pds_space_member(BOUNDARY, "did:plc:jet")
                .unwrap()
        );
    }

    #[tokio::test]
    async fn leaves_the_prior_baseline_unchanged_after_a_partial_failure() {
        let reconciler = reconciler(vec![
            Ok(SpaceMembershipPage {
                members: vec![member(
                    "did:plc:new",
                    RepoCustody::Pds,
                    Some("https://new.example.test/"),
                )],
                next_cursor: Some("two".to_owned()),
            }),
            Err(SpaceMembershipError::Unavailable),
        ]);
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .replace_pds_space_members(
                BOUNDARY,
                vec![PdsSpaceMember {
                    did: "did:plc:old".to_owned(),
                }],
                NOW,
            )
            .unwrap();

        assert!(matches!(
            reconciler.reconcile(&mut store, BOUNDARY, NOW).await,
            Err(MembershipReconciliationError::Membership(
                SpaceMembershipError::Unavailable
            ))
        ));
        assert!(
            store
                .is_current_pds_space_member(BOUNDARY, "did:plc:old")
                .unwrap()
        );
        assert!(
            !store
                .is_current_pds_space_member(BOUNDARY, "did:plc:new")
                .unwrap()
        );
    }

    #[tokio::test]
    async fn rejects_repeated_cursors_without_replacing_the_baseline() {
        let reconciler = reconciler(vec![
            Ok(SpaceMembershipPage {
                members: Vec::new(),
                next_cursor: Some("same".to_owned()),
            }),
            Ok(SpaceMembershipPage {
                members: Vec::new(),
                next_cursor: Some("same".to_owned()),
            }),
        ]);
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();

        assert!(matches!(
            reconciler.reconcile(&mut store, BOUNDARY, NOW).await,
            Err(MembershipReconciliationError::CursorStalled)
        ));
    }
}

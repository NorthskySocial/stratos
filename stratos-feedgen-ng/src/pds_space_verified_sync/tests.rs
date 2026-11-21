//! Every test runs the synchronizer over a real encrypted in-memory store
//! behind the real `ControlLifecycle` and the in-process host of `test_host`.
//! That host derives its MAC secret with the code under test, so these tests
//! prove how a cycle flows and what it writes, not that the cryptography is
//! right: the MAC and the set hash have their own vectors.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::{
    FailureReason, PdsSpaceVerifiedSynchronizer, PollEnd, SyncLimits, VerifiedSyncOutcome,
    promotion_refusal, replacement_refusal,
    test_host::{
        ArchiveStep, Fault, Gate, HostRepo, PageStep, StaticKemKeys, TestClock, TestHost,
        TestSource, cid_of, page_body, star_archive, tid,
    },
};
use crate::{
    config::{SPACE_REPLACEMENT_COOLDOWN, SPACE_TARGET_DEADLINE},
    credential_issuer::{
        CredentialExpiry, CredentialMintError, IssuedSpaceCredential, SpaceCredentialIssuer,
    },
    credential_manager::SpaceCredentialManager,
    lifecycle::ControlLifecycle,
    membership_reconciler::PdsPollTarget,
    moderation_label::{LabelPage, LabelSubject, ModerationLabel},
    readiness::FeedReadinessGate,
    service::ProjectionReader,
    space_http_signature::SpaceHttpSignatureKey,
    space_mac::MacVerifiedCommit,
    space_record::encode_record,
    store::{EncryptedStore, PdsSpaceMember, StorageKey, StoreError, VerifiedSpaceBase},
};

const AUTHORITY: &str = "did:web:stratos.example.test";
const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
const SPACE: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop";
const FAYE: &str = "did:plc:fayevalentine";
const JET: &str = "did:plc:jetblack";
const HOST: &str = "https://pds.bebop.example/";
const OTHER_HOST: &str = "https://pds.redtail.example/";
const OBSERVED: &str = "2026-09-22T00:00:00.000Z";
const RETAINED: &str = "2026-09-23T00:00:00.000Z";
const AS_OF: &str = "2026-09-22T12:00:00.000Z";
const POST: &str = "zone.stratos.feed.post";
const LIKE: &str = "app.bsky.feed.like";
const REPOST: &str = "app.bsky.feed.repost";
const FOLLOW: &str = "app.bsky.graph.follow";
const SWORDFISH_URI: &str = "at://did:plc:fayevalentine/zone.stratos.feed.post/swordfish";

struct CountingIssuer(Arc<AtomicUsize>);

#[async_trait]
impl SpaceCredentialIssuer for CountingIssuer {
    async fn mint(
        &self,
        _: &str,
        _: &SpaceHttpSignatureKey,
        _: u64,
    ) -> Result<IssuedSpaceCredential, CredentialMintError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(IssuedSpaceCredential {
            credential: "header.payload.signature".to_owned(),
            expires_at: CredentialExpiry::from_epoch_seconds(10_000),
        })
    }
}

fn credential_clock() -> u64 {
    1_000
}

struct Scene {
    lifecycle: Arc<ControlLifecycle>,
    host: Arc<TestHost>,
    source: Arc<TestSource>,
    kem_keys: Arc<StaticKemKeys>,
    clock: Arc<TestClock>,
    mints: Arc<AtomicUsize>,
    synchronizer: PdsSpaceVerifiedSynchronizer,
}

fn post(text: &str) -> Value {
    json!({ "$type": POST, "text": text, "createdAt": "1998-04-03T00:00:00.000Z" })
}

fn like_of_swordfish() -> Value {
    json!({ "$type": LIKE, "subject": { "uri": SWORDFISH_URI } })
}

fn follow(name: &str) -> Value {
    json!({ "$type": FOLLOW, "subject": format!("did:plc:{name}") })
}

impl Scene {
    fn new() -> Self {
        Self::with_limits(SyncLimits::default())
    }

    fn with_limits(limits: SyncLimits) -> Self {
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .replace_pds_space_members(
                BOUNDARY,
                [FAYE, JET]
                    .map(|did| PdsSpaceMember {
                        did: did.to_owned(),
                    })
                    .to_vec(),
                OBSERVED,
            )
            .unwrap();
        let lifecycle = Arc::new(
            ControlLifecycle::for_authority(
                ProjectionReader::new(store),
                Arc::new(Mutex::new(FeedReadinessGate::default())),
                AUTHORITY,
            )
            .unwrap(),
        );
        let host = TestHost::serving(SPACE);
        host.hold(FAYE, HostRepo::new(1));
        host.hold(JET, HostRepo::new(1));
        let kem_keys = StaticKemKeys::new();
        let source = TestSource::new(Arc::clone(&kem_keys));
        source.host_at(HOST, Arc::clone(&host));
        let clock = TestClock::new();
        let mints = Arc::new(AtomicUsize::new(0));
        let synchronizer = PdsSpaceVerifiedSynchronizer::with_clock(
            Arc::clone(&source) as _,
            Arc::new(SpaceCredentialManager::with_clock(
                Arc::new(CountingIssuer(Arc::clone(&mints))),
                credential_clock,
            )),
            Arc::clone(&clock) as _,
        )
        .with_limits(limits);
        Self {
            lifecycle,
            host,
            source,
            kem_keys,
            clock,
            mints,
            synchronizer,
        }
    }

    fn target(&self, did: &str) -> PdsPollTarget {
        PdsPollTarget {
            space_uri: SPACE.to_owned(),
            boundary: BOUNDARY.to_owned(),
            did: did.to_owned(),
            host: HOST.to_owned(),
            generation: self
                .lifecycle
                .pds_member_generation(BOUNDARY, did)
                .unwrap()
                .expect("a current member"),
        }
    }

    async fn cycle(&self, did: &str) -> VerifiedSyncOutcome {
        self.cycle_target(&self.target(did)).await
    }

    async fn cycle_target(&self, target: &PdsPollTarget) -> VerifiedSyncOutcome {
        self.synchronizer
            .sync_target(&self.lifecycle, target, RETAINED)
            .await
    }

    fn snapshot(&self) -> Vec<(String, Vec<String>)> {
        self.lifecycle
            .read(|projection| projection.table_snapshot())
    }

    fn served(&self) -> Vec<(String, String)> {
        self.lifecycle
            .read(|projection| projection.served_posts(BOUNDARY, AS_OF))
    }

    fn served_uris(&self) -> Vec<String> {
        self.served().into_iter().map(|(uri, _)| uri).collect()
    }

    fn interactions(&self) -> Vec<(String, String, String, String)> {
        self.lifecycle
            .read(|projection| projection.interaction_rows())
    }

    fn base(&self, did: &str) -> Option<VerifiedSpaceBase> {
        let generation = self
            .lifecycle
            .pds_member_generation(BOUNDARY, did)
            .unwrap()?;
        self.lifecycle
            .verified_space_base_at_generation(BOUNDARY, SPACE, did, generation)
            .unwrap()
    }

    fn base_rev(&self, did: &str) -> Option<String> {
        self.base(did).map(|base| base.rev)
    }

    fn host_digest(&self, did: &str) -> [u8; 32] {
        let mut digest = [0; 32];
        self.host.edit(did, |repo| digest = repo.digest());
        digest
    }

    fn base_digest(&self, did: &str) -> [u8; 32] {
        self.base(did).expect("a base").state.digest()
    }

    // The ops the host would send since `since`, as written on the wire.
    fn wire_ops(&self, did: &str, since: Option<&str>) -> Vec<Value> {
        let mut ops = Vec::new();
        self.host.edit(did, |repo| {
            ops = repo
                .ops_since(since)
                .iter()
                .map(|op| op.as_wire())
                .collect();
        });
        ops
    }

    fn host_rev(&self, did: &str) -> String {
        let mut rev = String::new();
        self.host.edit(did, |repo| rev = repo.rev().to_owned());
        rev
    }

    // A member whose repo holds two posts, already replaced into the store.
    async fn with_a_base() -> Self {
        let scene = Self::new();
        scene.host.edit(FAYE, |repo| {
            repo.put(2, POST, "ein", post("Woof"));
            repo.put(3, POST, "swordfish", post("See you space cowboy"));
        });
        assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);
        assert_eq!(scene.base_rev(FAYE), Some(tid(3)));
        scene
    }

    async fn with_a_base_and_limits(limits: SyncLimits) -> Self {
        let scene = Self::with_limits(limits);
        scene.host.edit(FAYE, |repo| {
            repo.put(2, POST, "ein", post("Woof"));
            repo.put(3, POST, "swordfish", post("See you space cowboy"));
        });
        assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);
        scene
    }
}

fn pages_of(scene: &Scene, did: &str) -> Vec<(Option<String>, Option<String>)> {
    scene.host.pages_requested(did)
}

#[tokio::test]
async fn the_first_sync_of_a_member_is_a_replacement_that_polls_nothing() {
    let scene = Scene::new();
    scene.host.edit(FAYE, |repo| {
        repo.put(2, POST, "ein", post("Woof"));
        repo.put(3, POST, "swordfish", post("See you space cowboy"));
    });

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);

    assert!(pages_of(&scene, FAYE).is_empty(), "no base, no poll");
    assert_eq!(scene.host.archives_requested(), 1);
    assert_eq!(scene.base_rev(FAYE), Some(tid(3)));
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
    assert_eq!(scene.served().len(), 2);
}

async fn promote_five_ops_in_pages_of(page_size: usize) -> (Scene, VerifiedSyncOutcome) {
    let scene = Scene::with_a_base().await;
    scene.host.set_page_size(page_size);
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "ein", post("Woof, woof"));
        repo.put(6, POST, "hammerhead", post("Bang"));
        repo.remove(7, POST, "swordfish");
        repo.put(8, POST, "kamehameha", post("Tokyo-3"));
    });
    let outcome = scene.cycle(FAYE).await;
    (scene, outcome)
}

#[tokio::test]
async fn creates_updates_and_deletes_over_one_two_and_three_pages_promote() {
    for (page_size, pages) in [(1_000, 1), (3, 2), (2, 3)] {
        let (scene, outcome) = promote_five_ops_in_pages_of(page_size).await;

        assert_eq!(
            outcome,
            VerifiedSyncOutcome::Promoted,
            "page size {page_size}"
        );
        assert_eq!(pages_of(&scene, FAYE).len(), pages, "page size {page_size}");
        assert_eq!(scene.base_rev(FAYE), Some(tid(8)));
        assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
        let mut expected = ["ein", "redtail", "hammerhead", "kamehameha"]
            .map(|rkey| format!("{SPACE}/{FAYE}/{POST}/{rkey}"));
        expected.sort();
        assert_eq!(scene.served_uris(), expected, "swordfish was deleted");
        assert_eq!(
            scene.host.archives_requested(),
            1,
            "only the first sync read an archive"
        );
    }
}

#[tokio::test]
async fn a_full_page_followed_by_an_empty_last_page_promotes() {
    let scene = Scene::with_a_base().await;
    scene.host.set_page_size(2);
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "hammerhead", post("Bang"));
    });

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);

    let pages = pages_of(&scene, FAYE);
    assert_eq!(
        pages.len(),
        2,
        "the full page carried a cursor, so a last page was read"
    );
    assert_eq!(pages[1].1.as_deref(), Some("2"));
    assert_eq!(scene.base_rev(FAYE), Some(tid(5)));
}

#[tokio::test]
async fn the_commit_of_the_last_page_is_the_one_used_when_the_commit_advances_between_pages() {
    let scene = Scene::with_a_base().await;
    scene.host.set_page_size(2);
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "hammerhead", post("Bang"));
        repo.put(6, POST, "kamehameha", post("Tokyo-3"));
    });
    // The first page is served at revision 6; before the second the host writes
    // once more, so the two pages carry different commits.
    scene.host.script_pages(
        FAYE,
        vec![
            PageStep::HonestThen(Box::new(|repo: &mut HostRepo| {
                repo.put(7, POST, "bebop", post("Spike"));
            })),
            PageStep::Honest,
        ],
    );

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);

    assert_eq!(scene.base_rev(FAYE), Some(tid(7)));
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
}

#[tokio::test]
async fn a_member_at_the_held_revision_is_unchanged_and_nothing_is_written() {
    let scene = Scene::with_a_base().await;
    let before = scene.snapshot();

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Unchanged);

    assert_eq!(scene.snapshot(), before);
    assert_eq!(pages_of(&scene, FAYE), [(Some(tid(3)), None)]);
    assert_eq!(scene.host.archives_requested(), 1);
}

#[tokio::test]
async fn since_is_the_verified_revision_on_every_request_and_the_page_cursor_is_never_stored() {
    let scene = Scene::with_a_base().await;
    scene.host.set_page_size(2);
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "hammerhead", post("Bang"));
        repo.put(6, POST, "kamehameha", post("Tokyo-3"));
    });

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);
    assert_eq!(
        pages_of(&scene, FAYE),
        [(Some(tid(3)), None), (Some(tid(3)), Some("2".to_owned())),],
        "since is the base's revision, the cursor is the previous page's"
    );

    // The next poll starts again from the new base and no cursor, not from
    // where the last poll's pages ended.
    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Unchanged);
    assert_eq!(
        pages_of(&scene, FAYE).last().cloned(),
        Some((Some(tid(6)), None))
    );
}

#[tokio::test]
async fn a_crashed_poll_leaves_no_state_and_the_next_poll_starts_from_the_verified_rev() {
    let scene = Scene::with_a_base().await;
    scene.host.set_page_size(2);
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "hammerhead", post("Bang"));
        repo.put(6, POST, "kamehameha", post("Tokyo-3"));
    });
    let before = scene.snapshot();
    let gate = Gate::new();
    scene
        .host
        .script_pages(FAYE, vec![PageStep::Honest, PageStep::Gate(gate.clone())]);

    // The second page is requested and never answered: the cycle is dropped
    // where it stands, as a crash would drop it.
    tokio::select! {
        outcome = scene.cycle(FAYE) => panic!("the cycle finished: {outcome:?}"),
        () = gate.reached.notified() => {}
    }

    assert_eq!(
        scene.snapshot(),
        before,
        "nothing of the first page was written"
    );
    assert_eq!(scene.base_rev(FAYE), Some(tid(3)));

    scene.host.script_pages(FAYE, vec![]);
    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);
    let pages = pages_of(&scene, FAYE);
    let restart = &pages[pages.len() - 2];
    assert_eq!(
        restart,
        &(Some(tid(3)), None),
        "the next poll starts from the verified revision with no cursor"
    );
    assert_eq!(scene.base_rev(FAYE), Some(tid(6)));
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
}

#[tokio::test]
async fn the_records_of_a_poll_are_invisible_until_promotion() {
    let scene = Scene::with_a_base().await;
    scene.host.set_page_size(2);
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "hammerhead", post("Bang"));
        repo.put(6, POST, "kamehameha", post("Tokyo-3"));
    });
    let before = scene.snapshot();
    let served_before = scene.served();
    let gate = Gate::new();
    scene
        .host
        .script_pages(FAYE, vec![PageStep::Honest, PageStep::Gate(gate.clone())]);

    let (outcome, ()) = tokio::join!(scene.cycle(FAYE), async {
        // The first page is read and the second is in flight.
        gate.reached.notified().await;
        assert_eq!(scene.snapshot(), before, "every table is as it was");
        assert_eq!(scene.served(), served_before);
        gate.release.notify_one();
    });

    assert_eq!(outcome, VerifiedSyncOutcome::Promoted);
    assert_eq!(scene.served().len(), 5);
}

fn like_claiming_another_boundary() -> Value {
    json!({
        "$type": LIKE,
        "subject": { "uri": SWORDFISH_URI },
        "boundary": {
            "$type": "zone.stratos.boundary.defs#domains",
            "values": [{ "$type": "zone.stratos.boundary.defs#domain", "value": "leadership" }],
        },
    })
}

#[tokio::test]
async fn a_like_takes_the_targets_boundary_and_is_invisible_until_promotion() {
    let scene = Scene::with_a_base().await;
    scene.host.set_page_size(1);
    scene.host.edit(FAYE, |repo| {
        repo.put(4, LIKE, "ed", like_claiming_another_boundary());
        repo.put(5, POST, "redtail", post("Cowboy Bebop"));
    });
    let gate = Gate::new();
    scene
        .host
        .script_pages(FAYE, vec![PageStep::Honest, PageStep::Gate(gate.clone())]);

    let (outcome, ()) = tokio::join!(scene.cycle(FAYE), async {
        gate.reached.notified().await;
        assert!(
            scene.interactions().is_empty(),
            "the like is read, not served"
        );
        gate.release.notify_one();
    });

    assert_eq!(outcome, VerifiedSyncOutcome::Promoted);
    assert_eq!(
        scene.interactions(),
        [(
            format!("{SPACE}/{FAYE}/{LIKE}/ed"),
            "like".to_owned(),
            SWORDFISH_URI.to_owned(),
            BOUNDARY.to_owned()
        )],
        "the boundary the record claimed is not the one it was stored under"
    );
}

fn take_down_account(scene: &Scene, did: &str) {
    scene
        .lifecycle
        .apply_label_page(
            &LabelPage {
                cursor: 1,
                labels: vec![ModerationLabel {
                    seq: 1,
                    subject: LabelSubject::Account {
                        did: did.to_owned(),
                    },
                    neg: false,
                }],
                skipped_subjects: 0,
            },
            OBSERVED,
        )
        .unwrap();
    // A takedown unenrols the account's boundaries; the member is listed again
    // by the authority, as it would be on the next membership pass.
    scene
        .lifecycle
        .replace_pds_space_members(
            BOUNDARY,
            [FAYE, JET]
                .map(|did| PdsSpaceMember {
                    did: did.to_owned(),
                })
                .to_vec(),
            "2026-09-22T00:00:01.000Z",
        )
        .unwrap();
}

#[tokio::test]
async fn a_taken_down_accounts_like_is_not_promoted() {
    let like_scene = |scene: &Scene| {
        scene.host.edit(FAYE, |repo| {
            repo.put(2, POST, "swordfish", post("See you space cowboy"));
            repo.put(3, LIKE, "ed", like_of_swordfish());
        });
    };
    let control = Scene::new();
    like_scene(&control);
    assert_eq!(control.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);
    assert_eq!(
        control.interactions().len(),
        1,
        "the like is served without a takedown"
    );

    let taken_down = Scene::new();
    take_down_account(&taken_down, FAYE);
    like_scene(&taken_down);
    assert_eq!(taken_down.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);
    assert!(
        taken_down.interactions().is_empty(),
        "the whole repo is read, nothing is served"
    );
    assert!(taken_down.served().is_empty());

    // An incremental poll for the same member under the takedown promotes its
    // path rows and projects nothing.
    taken_down.host.edit(FAYE, |repo| {
        repo.put(4, LIKE, "jet", like_of_swordfish());
    });
    assert_eq!(taken_down.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);
    assert_eq!(taken_down.base_rev(FAYE), Some(tid(4)));
    assert!(taken_down.interactions().is_empty());
}

#[tokio::test]
async fn a_tampered_page_that_is_not_the_last_fails_and_nothing_is_written() {
    let scene = Scene::with_a_base().await;
    scene.host.set_page_size(2);
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "hammerhead", post("Bang"));
        repo.put(6, POST, "kamehameha", post("Tokyo-3"));
    });
    let before = scene.snapshot();
    let mut first_page = scene.wire_ops(FAYE, Some(&tid(3)));
    first_page.truncate(2);
    first_page[1]["value"]["text"] = json!("Spike did this");
    scene.host.script_pages(
        FAYE,
        vec![PageStep::Written {
            ops: first_page,
            cursor: Some("2".to_owned()),
            commit_rev: scene.host_rev(FAYE),
            commit_data: scene.host_digest(FAYE),
            padding_bytes: 0,
        }],
    );

    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::RecordRefused)
    );

    assert_eq!(scene.snapshot(), before);
    assert_eq!(
        scene.host.archives_requested(),
        1,
        "a refused value is not recovered from"
    );
}

#[tokio::test]
async fn a_tamper_that_keeps_its_cid_in_step_leads_to_one_replacement_to_the_hosts_real_state() {
    let scene = Scene::with_a_base().await;
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
    });
    let mut ops = scene.wire_ops(FAYE, Some(&tid(3)));
    let forged = post("Spike did this");
    ops[0]["value"] = forged.clone();
    ops[0]["cid"] = json!(cid_of(&forged).to_string());
    scene.host.script_pages(
        FAYE,
        vec![PageStep::Written {
            ops,
            cursor: None,
            commit_rev: scene.host_rev(FAYE),
            commit_data: scene.host_digest(FAYE),
            padding_bytes: 0,
        }],
    );

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);

    assert_eq!(scene.host.archives_requested(), 2);
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
    assert!(
        scene
            .served_uris()
            .contains(&format!("{SPACE}/{FAYE}/{POST}/redtail"))
    );
}

#[tokio::test]
async fn a_wrong_digest_on_the_last_page_leads_to_one_replacement_and_its_state() {
    let scene = Scene::with_a_base().await;
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
    });
    scene
        .host
        .script_pages(FAYE, vec![PageStep::WrongDigest([9; 32])]);

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);

    assert_eq!(
        scene.host.archives_requested(),
        2,
        "the first sync and this one"
    );
    assert_eq!(scene.base_rev(FAYE), Some(tid(4)));
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
    assert_eq!(scene.served().len(), 3);
}

#[tokio::test]
async fn a_replacement_whose_digest_is_wrong_fails_and_the_earlier_state_stands() {
    let scene = Scene::with_a_base().await;
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
    });
    scene
        .host
        .script_pages(FAYE, vec![PageStep::WrongDigest([9; 32])]);
    scene
        .host
        .script_archives(FAYE, vec![ArchiveStep::WrongDigest([8; 32])]);
    let before = scene.snapshot();

    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::Digest)
    );

    assert_eq!(scene.snapshot(), before);
    assert_eq!(scene.base_rev(FAYE), Some(tid(3)));
    assert_eq!(
        scene.host.archives_requested(),
        2,
        "one replacement, not two"
    );
}

#[tokio::test]
async fn a_gap_in_the_hosts_oplog_leads_to_a_replacement() {
    let scene = Scene::with_a_base().await;
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        // A host that dropped its oplog answers an old `since` with only the
        // ops written after the drop, and no error.
        repo.forget_oplog();
        repo.put(5, POST, "hammerhead", post("Bang"));
    });

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);

    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
    assert_eq!(scene.served().len(), 4);
}

#[tokio::test]
async fn ops_that_do_not_follow_each_other_lead_to_a_replacement() {
    let scene = Scene::with_a_base().await;
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "redtail", post("Cowboy Bebop, again"));
    });
    let mut ops = scene.wire_ops(FAYE, Some(&tid(3)));
    ops[1]["prev"] = json!(cid_of(&post("Not what was written")).to_string());
    scene.host.script_pages(
        FAYE,
        vec![PageStep::Written {
            ops,
            cursor: None,
            commit_rev: scene.host_rev(FAYE),
            commit_data: scene.host_digest(FAYE),
            padding_bytes: 0,
        }],
    );

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
}

#[tokio::test]
async fn ops_outside_the_revision_bounds_fail_the_target() {
    // The base is at revision 3 and the host is at 6.
    let build = || async {
        let scene = Scene::with_a_base().await;
        scene.host.edit(FAYE, |repo| {
            repo.put(4, POST, "redtail", post("Cowboy Bebop"));
            repo.put(5, POST, "hammerhead", post("Bang"));
            repo.put(6, POST, "kamehameha", post("Tokyo-3"));
        });
        scene
    };
    let rewritten = |scene: &Scene, revs: [u32; 3], commit_rev: u32| PageStep::Written {
        ops: scene
            .wire_ops(FAYE, Some(&tid(3)))
            .into_iter()
            .zip(revs)
            .map(|(mut op, rev)| {
                op["rev"] = json!(tid(rev));
                op
            })
            .collect(),
        cursor: None,
        commit_rev: tid(commit_rev),
        commit_data: scene.host_digest(FAYE),
        padding_bytes: 0,
    };
    for (name, revs, commit_rev) in [
        ("an op at the base's revision", [3, 5, 6], 6),
        ("an op below the base's revision", [2, 5, 6], 6),
        ("an op above the last commit's revision", [4, 5, 7], 6),
        ("an op below the one before it", [4, 6, 5], 6),
    ] {
        let scene = build().await;
        let before = scene.snapshot();
        let step = rewritten(&scene, revs, commit_rev);
        scene.host.script_pages(FAYE, vec![step]);

        assert_eq!(
            scene.cycle(FAYE).await,
            VerifiedSyncOutcome::Failed(FailureReason::Page),
            "{name}"
        );
        assert_eq!(scene.snapshot(), before, "{name}");
        assert_eq!(scene.host.archives_requested(), 1, "{name}: no replacement");
    }

    // Equal revisions are allowed, and so is an op at the commit's own.
    let scene = build().await;
    scene.host.edit(FAYE, |repo| {
        repo.put(6, POST, "bebop", post("Spike"));
    });
    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);
}

fn the_base_records_at_revisions_one_and_two() -> HostRepo {
    let mut repo = HostRepo::new(1);
    repo.put(1, POST, "ein", post("Woof"));
    repo.put(2, POST, "swordfish", post("See you space cowboy"));
    repo
}

#[tokio::test]
async fn a_host_gone_back_to_an_older_revision_with_an_equal_digest_is_replaced_at_that_revision() {
    let scene = Scene::with_a_base().await;
    // Restored from a backup that holds the base's records under older
    // revisions: the digest is the base's, the revision is below it.
    scene
        .host
        .hold(FAYE, the_base_records_at_revisions_one_and_two());
    assert_eq!(scene.host_digest(FAYE), scene.base_digest(FAYE));

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);

    assert_eq!(scene.base_rev(FAYE), Some(tid(2)));
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
    assert_eq!(scene.host.archives_requested(), 2);
    assert_eq!(scene.served().len(), 2);
    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Unchanged);
}

#[tokio::test]
async fn a_repeated_cursor_fails_the_target() {
    let scene = Scene::with_a_base().await;
    let before = scene.snapshot();
    let page = |cursor: &str| PageStep::Written {
        ops: vec![],
        cursor: Some(cursor.to_owned()),
        commit_rev: tid(3),
        commit_data: [0; 32],
        padding_bytes: 0,
    };
    scene
        .host
        .script_pages(FAYE, vec![page("1"), page("2"), page("1")]);

    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::CursorStalled)
    );

    assert_eq!(scene.snapshot(), before);
    assert_eq!(pages_of(&scene, FAYE).len(), 3);
}

#[tokio::test]
async fn a_missing_value_on_a_post_path_leads_to_a_replacement_and_on_another_collection_promotes()
{
    let dropped_value = |scene: &Scene| {
        let mut ops = scene.wire_ops(FAYE, Some(&tid(3)));
        for op in &mut ops {
            op.as_object_mut().unwrap().remove("value");
        }
        PageStep::Written {
            ops,
            cursor: None,
            commit_rev: scene.host_rev(FAYE),
            commit_data: scene.host_digest(FAYE),
            padding_bytes: 0,
        }
    };

    for collection in [POST, LIKE, REPOST] {
        let scene = Scene::with_a_base().await;
        let value = match collection {
            POST => post("Cowboy Bebop"),
            LIKE => like_of_swordfish(),
            _ => json!({ "$type": REPOST, "subject": { "uri": SWORDFISH_URI } }),
        };
        scene.host.edit(FAYE, |repo| {
            repo.put(4, collection, "redtail", value);
        });
        let step = dropped_value(&scene);
        scene.host.script_pages(FAYE, vec![step]);

        assert_eq!(
            scene.cycle(FAYE).await,
            VerifiedSyncOutcome::Replaced,
            "{collection}"
        );
        assert_eq!(scene.host.archives_requested(), 2, "{collection}");
        assert_eq!(
            scene.base_digest(FAYE),
            scene.host_digest(FAYE),
            "{collection}"
        );
    }

    let scene = Scene::with_a_base().await;
    scene.host.edit(FAYE, |repo| {
        repo.put(4, FOLLOW, "spike", follow("spikespiegel"));
    });
    let step = dropped_value(&scene);
    scene.host.script_pages(FAYE, vec![step]);
    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);
    assert_eq!(scene.host.archives_requested(), 1);
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
    assert_eq!(scene.served().len(), 2, "a follow is never served");
}

#[tokio::test]
async fn a_thousand_ops_promote_and_a_thousand_and_one_lead_to_a_replacement() {
    for (ops, outcome, pages) in [
        (1_000_u32, VerifiedSyncOutcome::Promoted, 2),
        (1_001, VerifiedSyncOutcome::Replaced, 2),
    ] {
        let scene = Scene::with_a_base().await;
        scene.host.edit(FAYE, |repo| {
            for at in 0..ops {
                repo.put(4 + at, POST, &format!("post{at:04}"), post("Bang"));
            }
        });

        assert_eq!(scene.cycle(FAYE).await, outcome, "{ops} ops");

        // A full page carries a cursor, so a page of 1,000 ops is followed by
        // another that is empty.
        assert_eq!(pages_of(&scene, FAYE).len(), pages, "{ops} ops");
        assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
    }
}

#[tokio::test]
async fn sixteen_mebibytes_of_page_bodies_are_read_and_one_more_byte_leads_to_a_replacement() {
    let limit = crate::config::MAX_SPACE_POLL_BODY_BYTES;
    for (extra, outcome) in [
        (0, VerifiedSyncOutcome::Unchanged),
        (1, VerifiedSyncOutcome::Replaced),
    ] {
        let scene = Scene::with_a_base().await;
        let unpadded =
            page_body(SPACE, FAYE, &[], None, &tid(3), &scene.host_digest(FAYE), 0).len();
        // One padding byte adds the member's name and quotes as well.
        let overhead = page_body(SPACE, FAYE, &[], None, &tid(3), &scene.host_digest(FAYE), 1)
            .len()
            - unpadded
            - 1;
        let padding_bytes = limit + extra - unpadded - overhead;
        scene.host.script_pages(
            FAYE,
            vec![PageStep::Written {
                ops: vec![],
                cursor: None,
                commit_rev: tid(3),
                commit_data: scene.host_digest(FAYE),
                padding_bytes,
            }],
        );

        assert_eq!(scene.cycle(FAYE).await, outcome, "{extra} bytes over");
    }
}

#[tokio::test]
async fn a_poll_that_runs_out_of_pages_leads_to_a_replacement() {
    let limits = SyncLimits {
        pages: 3,
        ..SyncLimits::default()
    };
    for (ops, outcome) in [
        (2_u32, VerifiedSyncOutcome::Promoted),
        (3, VerifiedSyncOutcome::Replaced),
    ] {
        let scene = Scene::with_a_base_and_limits(limits).await;
        scene.host.set_page_size(1);
        scene.host.edit(FAYE, |repo| {
            for at in 0..ops {
                repo.put(4 + at, POST, &format!("post{at}"), post("Bang"));
            }
        });

        // One op to a page: two ops are read on pages one and two, and the
        // third page is the empty last one; three ops leave a cursor on the
        // third page.
        assert_eq!(scene.cycle(FAYE).await, outcome, "{ops} ops, three pages");
        assert_eq!(pages_of(&scene, FAYE).len(), 3);
    }
    assert_eq!(super::MAX_POLL_PAGES, 1_000);
}

#[tokio::test]
async fn an_archive_over_a_limit_fails_as_over_budget_and_changes_nothing() {
    let too_many_records = || {
        (0..=crate::config::MAX_SPACE_REPO_RECORDS)
            .map(|at| (format!("moe.bebop.crew/k{at:06}"), vec![0xa0]))
            .collect::<Vec<_>>()
    };
    let too_many_bytes = || {
        (0..17)
            .map(|at| {
                let value = encode_record(&json!({ "p": "a".repeat(1_000_000) })).unwrap();
                (format!("moe.bebop.crew/k{at:02}"), value)
            })
            .collect::<Vec<_>>()
    };
    for (name, pairs) in [
        ("more records than a repo may hold", too_many_records()),
        ("more bytes than an archive may hold", too_many_bytes()),
    ] {
        let scene = Scene::with_a_base().await;
        scene.host.edit(FAYE, |repo| {
            repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        });
        scene
            .host
            .script_pages(FAYE, vec![PageStep::WrongDigest([9; 32])]);
        let archive = star_archive(FAYE, SPACE, &tid(4), &scene.host_digest(FAYE), pairs);
        scene
            .host
            .script_archives(FAYE, vec![ArchiveStep::Raw(archive)]);
        let before = scene.snapshot();

        assert_eq!(
            scene.cycle(FAYE).await,
            VerifiedSyncOutcome::Failed(FailureReason::RepoOverBudget),
            "{name}"
        );
        assert_eq!(scene.snapshot(), before, "{name}");
    }
}

#[tokio::test]
async fn a_page_past_the_decoded_value_budget_fails_and_one_at_it_is_accepted() {
    let ops_value_count = |scene: &Scene| {
        let body = page_body(
            SPACE,
            FAYE,
            &scene.wire_ops(FAYE, Some(&tid(3))),
            None,
            &scene.host_rev(FAYE),
            &scene.host_digest(FAYE),
            0,
        );
        crate::space_value_budget::count_body_values(&body, usize::MAX).unwrap()
    };
    let probe = Scene::with_a_base().await;
    probe.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
    });
    let at_the_limit = ops_value_count(&probe);

    for (values, outcome) in [
        (at_the_limit, VerifiedSyncOutcome::Promoted),
        (
            at_the_limit - 1,
            VerifiedSyncOutcome::Failed(FailureReason::RepoOverBudget),
        ),
    ] {
        // Replacing the first two posts needs their values counted too, so the
        // base is built under the default budget and the poll under the lowered.
        let scene = Scene::with_a_base().await;
        let lowered = Scene {
            synchronizer: PdsSpaceVerifiedSynchronizer::with_clock(
                Arc::clone(&scene.source) as _,
                Arc::new(SpaceCredentialManager::with_clock(
                    Arc::new(CountingIssuer(Arc::clone(&scene.mints))),
                    credential_clock,
                )),
                Arc::clone(&scene.clock) as _,
            )
            .with_limits(SyncLimits {
                values,
                ..SyncLimits::default()
            }),
            ..scene
        };
        lowered.host.edit(FAYE, |repo| {
            repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        });
        let before = lowered.snapshot();

        assert_eq!(lowered.cycle(FAYE).await, outcome, "{values} values");
        if outcome != VerifiedSyncOutcome::Promoted {
            assert_eq!(lowered.snapshot(), before);
            assert_eq!(lowered.host.archives_requested(), 1, "not recovered from");
        }
    }
}

#[tokio::test]
async fn an_archive_past_the_decoded_value_budget_fails_and_one_at_it_is_replaced() {
    // Two posts of a map, its type, its text and its time: four values each.
    for (values, outcome) in [
        (8, VerifiedSyncOutcome::Replaced),
        (
            7,
            VerifiedSyncOutcome::Failed(FailureReason::RepoOverBudget),
        ),
    ] {
        let scene = Scene::with_limits(SyncLimits {
            values,
            ..SyncLimits::default()
        });
        scene.host.edit(FAYE, |repo| {
            repo.put(2, POST, "ein", post("Woof"));
            repo.put(3, POST, "swordfish", post("See you space cowboy"));
            // A follow is held to its CID and dropped, so it costs nothing.
            repo.put(4, FOLLOW, "spike", follow("spikespiegel"));
        });
        let before = scene.snapshot();

        assert_eq!(scene.cycle(FAYE).await, outcome, "{values} values");
        if outcome != VerifiedSyncOutcome::Replaced {
            assert_eq!(scene.snapshot(), before);
        }
    }
}

async fn with_a_gap_to_recover_from() -> Scene {
    let scene = Scene::with_a_base().await;
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
    });
    scene
}

#[tokio::test]
async fn repo_not_found_with_status_400_clears_the_members_state_and_nothing_else() {
    let scene = Scene::with_a_base().await;
    scene.host.edit(JET, |repo| {
        repo.put(2, POST, "bebop", post("Spike"));
    });
    assert_eq!(scene.cycle(JET).await, VerifiedSyncOutcome::Replaced);
    scene.host.script_pages(
        FAYE,
        vec![PageStep::Refused {
            status: 400,
            code: Some("RepoNotFound"),
        }],
    );

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Cleared);

    assert_eq!(scene.base(FAYE), None);
    assert_eq!(
        scene.served_uris(),
        [format!("{SPACE}/{JET}/{POST}/bebop")],
        "Jet's post is still served"
    );
    assert!(scene.base(JET).is_some());
}

#[tokio::test]
async fn repo_not_found_from_an_archive_request_clears_too() {
    let scene = Scene::new();
    scene.host.script_archives(
        FAYE,
        vec![ArchiveStep::Refused {
            status: 400,
            code: Some("RepoNotFound"),
        }],
    );

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Cleared);
    assert_eq!(scene.base(FAYE), None);
}

#[tokio::test]
async fn only_repo_not_found_with_status_400_clears_and_only_invalid_cursor_replaces() {
    let refusals: [(&str, u16, Option<&str>, VerifiedSyncOutcome); 14] = [
        (
            "RepoNotFound",
            400,
            Some("RepoNotFound"),
            VerifiedSyncOutcome::Cleared,
        ),
        (
            "InvalidCursor",
            400,
            Some("InvalidCursor"),
            VerifiedSyncOutcome::Replaced,
        ),
        (
            "RepoTakendown",
            400,
            Some("RepoTakendown"),
            VerifiedSyncOutcome::Failed(FailureReason::RepoTakendown),
        ),
        (
            "RepoSuspended",
            400,
            Some("RepoSuspended"),
            VerifiedSyncOutcome::Failed(FailureReason::RepoSuspended),
        ),
        (
            "RepoDeactivated",
            400,
            Some("RepoDeactivated"),
            VerifiedSyncOutcome::Failed(FailureReason::RepoDeactivated),
        ),
        (
            "a 404 with an HTML body",
            404,
            None,
            VerifiedSyncOutcome::Failed(FailureReason::Other),
        ),
        (
            "a 500 with no name",
            500,
            None,
            VerifiedSyncOutcome::Failed(FailureReason::Other),
        ),
        (
            "the name in a 500",
            500,
            Some("RepoNotFound"),
            VerifiedSyncOutcome::Failed(FailureReason::RepoNotFound),
        ),
        (
            "the name in a 404",
            404,
            Some("RepoNotFound"),
            VerifiedSyncOutcome::Failed(FailureReason::RepoNotFound),
        ),
        (
            "the name with trailing text",
            400,
            Some("RepoNotFound and then some"),
            VerifiedSyncOutcome::Failed(FailureReason::Other),
        ),
        (
            "the name in other case",
            400,
            Some("repo_not_found"),
            VerifiedSyncOutcome::Failed(FailureReason::Other),
        ),
        (
            "an invalid cursor named in a 500",
            500,
            Some("InvalidCursor"),
            VerifiedSyncOutcome::Failed(FailureReason::InvalidCursor),
        ),
        (
            "an unknown name",
            400,
            Some("SpaceNotFound"),
            VerifiedSyncOutcome::Failed(FailureReason::Other),
        ),
        (
            "a 400 with no readable body",
            400,
            None,
            VerifiedSyncOutcome::Failed(FailureReason::Other),
        ),
    ];
    for (name, status, code, outcome) in refusals {
        let scene = with_a_gap_to_recover_from().await;
        scene
            .host
            .script_pages(FAYE, vec![PageStep::Refused { status, code }]);
        let before = scene.snapshot();

        assert_eq!(scene.cycle(FAYE).await, outcome, "{name}");

        match outcome {
            VerifiedSyncOutcome::Failed(_) => {
                assert_eq!(scene.snapshot(), before, "{name}: byte-identical rows");
                assert_eq!(scene.host.archives_requested(), 1, "{name}: no replacement");
            }
            VerifiedSyncOutcome::Replaced => {
                assert_eq!(scene.host.archives_requested(), 2, "{name}");
                assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
            }
            _ => assert_eq!(scene.base(FAYE), None, "{name}"),
        }
    }
}

#[tokio::test]
async fn invalid_cursor_on_a_later_page_replaces_the_poll() {
    let scene = with_a_gap_to_recover_from().await;
    scene.host.set_page_size(1);
    scene.host.script_pages(
        FAYE,
        vec![
            PageStep::Honest,
            PageStep::Refused {
                status: 400,
                code: Some("InvalidCursor"),
            },
        ],
    );

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
}

#[tokio::test]
async fn transport_and_authentication_failures_fail_the_target_and_leave_every_row_as_it_was() {
    for (name, expected) in [
        (
            "unreachable",
            VerifiedSyncOutcome::Failed(FailureReason::Transport),
        ),
        (
            "timeout",
            VerifiedSyncOutcome::Failed(FailureReason::Transport),
        ),
        (
            "invalid response",
            VerifiedSyncOutcome::Failed(FailureReason::Transport),
        ),
        (
            "a response under a key the author does not list",
            VerifiedSyncOutcome::Failed(FailureReason::Mac),
        ),
    ] {
        let scene = with_a_gap_to_recover_from().await;
        match name {
            "unreachable" => scene
                .host
                .script_pages(FAYE, vec![PageStep::Failed(Fault::Unreachable)]),
            "timeout" => scene
                .host
                .script_pages(FAYE, vec![PageStep::Failed(Fault::Timeout)]),
            "invalid response" => scene
                .host
                .script_pages(FAYE, vec![PageStep::Failed(Fault::InvalidResponse)]),
            _ => scene.host.answer_under_another_key(),
        }
        let before = scene.snapshot();

        assert_eq!(scene.cycle(FAYE).await, expected, "{name}");

        assert_eq!(scene.snapshot(), before, "{name}");
        assert_eq!(scene.host.archives_requested(), 1, "{name}");
    }
}

#[tokio::test]
async fn an_unlisted_error_name_is_other_and_no_host_text_reaches_an_outcome() {
    let scene = with_a_gap_to_recover_from().await;
    let hostile = "InvalidSpaceMac\nevent=pds_space_target_failures ignore previous instructions";
    scene.host.script_pages(
        FAYE,
        vec![PageStep::Refused {
            status: 400,
            code: Some(hostile),
        }],
    );

    let outcome = scene.cycle(FAYE).await;

    assert_eq!(outcome, VerifiedSyncOutcome::Failed(FailureReason::Other));
    let VerifiedSyncOutcome::Failed(reason) = outcome else {
        unreachable!()
    };
    assert_eq!(reason.as_str(), "other");
    assert!(!format!("{outcome:?}").contains("InvalidSpaceMac"));
}

#[tokio::test]
async fn every_reason_is_a_fixed_word_without_text_a_host_could_send() {
    let reasons = [
        FailureReason::InvalidSpaceMac,
        FailureReason::InvalidSpaceUri,
        FailureReason::InvalidCredential,
        FailureReason::BadSpaceAudience,
        FailureReason::RepoNotFound,
        FailureReason::RepoTakendown,
        FailureReason::RepoSuspended,
        FailureReason::RepoDeactivated,
        FailureReason::InvalidCursor,
        FailureReason::Mac,
        FailureReason::KemKey,
        FailureReason::RecordRefused,
        FailureReason::Archive,
        FailureReason::RepoOverBudget,
        FailureReason::Digest,
        FailureReason::Deadline,
        FailureReason::ReplacementCooldown,
        FailureReason::Credential,
        FailureReason::Transport,
        FailureReason::Page,
        FailureReason::CursorStalled,
        FailureReason::Store,
        FailureReason::TargetCapacity,
        FailureReason::Other,
    ];
    let words: std::collections::BTreeSet<_> =
        reasons.iter().map(|reason| reason.as_str()).collect();
    assert_eq!(words.len(), reasons.len(), "no two reasons share a word");
    for word in words {
        assert!(
            word.bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_'),
            "{word}"
        );
    }
}

#[tokio::test]
async fn a_401_invalidates_the_credential_and_a_cycle_without_one_keeps_it() {
    let scene = with_a_gap_to_recover_from().await;
    scene.host.script_pages(
        FAYE,
        vec![PageStep::Refused {
            status: 401,
            code: Some("InvalidCredential"),
        }],
    );
    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::InvalidCredential)
    );
    let minted_after_the_refusal = scene.mints.load(Ordering::SeqCst);

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);
    assert_eq!(
        scene.mints.load(Ordering::SeqCst),
        minted_after_the_refusal + 1,
        "the refused credential was not presented again"
    );

    let kept = scene.mints.load(Ordering::SeqCst);
    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Unchanged);
    assert_eq!(
        scene.mints.load(Ordering::SeqCst),
        kept,
        "a good credential is kept"
    );
}

#[tokio::test]
async fn a_key_the_directory_cannot_give_defers_the_target() {
    let scene = with_a_gap_to_recover_from().await;
    let before = scene.snapshot();
    scene.kem_keys.withdraw();

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Deferred);
    assert_eq!(scene.snapshot(), before);

    let first = Scene::new();
    first.kem_keys.withdraw();
    assert_eq!(first.cycle(FAYE).await, VerifiedSyncOutcome::Deferred);
    assert_eq!(first.base(FAYE), None);
}

#[tokio::test]
async fn archive_failures_fail_the_target_and_leave_every_row_as_it_was() {
    let canonical_follow = encode_record(&follow("spikespiegel")).unwrap();
    let non_canonical = vec![0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02];
    // The archives a host signs for its own commit: at revision 4 with `digest`.
    let archive_with = |digest: &[u8; 32], pairs: Vec<(String, Vec<u8>)>| {
        ArchiveStep::Raw(star_archive(FAYE, SPACE, &tid(4), digest, pairs))
    };
    let cases: [(&str, FailureReason); 5] = [
        ("an error answer", FailureReason::Other),
        ("a refused record value", FailureReason::RecordRefused),
        ("paths out of order", FailureReason::Archive),
        ("bytes that are no archive", FailureReason::Archive),
        ("a failed transport", FailureReason::Transport),
    ];
    for (name, reason) in cases {
        let scene = with_a_gap_to_recover_from().await;
        let digest = scene.host_digest(FAYE);
        let step = match name {
            "an error answer" => ArchiveStep::Refused {
                status: 500,
                code: None,
            },
            "a refused record value" => archive_with(
                &digest,
                vec![("moe.bebop.crew/spike".to_owned(), non_canonical.clone())],
            ),
            "paths out of order" => {
                // Two records written in the opposite of path order.
                let mut archive = star_archive(
                    FAYE,
                    SPACE,
                    &tid(4),
                    &digest,
                    vec![
                        ("moe.bebop.crew/a".to_owned(), canonical_follow.clone()),
                        ("moe.bebop.crew/b".to_owned(), canonical_follow.clone()),
                    ],
                );
                let a = archive
                    .windows(16)
                    .position(|window| window == b"moe.bebop.crew/a")
                    .unwrap();
                archive[a + 15] = b'c';
                ArchiveStep::Raw(archive)
            }
            "bytes that are no archive" => ArchiveStep::Raw(vec![0xde, 0xad, 0xbe, 0xef]),
            _ => ArchiveStep::Failed(Fault::Unreachable),
        };
        scene
            .host
            .script_pages(FAYE, vec![PageStep::WrongDigest([9; 32])]);
        scene.host.script_archives(FAYE, vec![step]);
        let before = scene.snapshot();

        assert_eq!(
            scene.cycle(FAYE).await,
            VerifiedSyncOutcome::Failed(reason),
            "{name}"
        );
        assert_eq!(scene.snapshot(), before, "{name}");
    }
}

async fn move_the_base_during_the_poll(
    scene: &Scene,
    between: impl FnOnce(&Scene),
) -> VerifiedSyncOutcome {
    let gate = Gate::new();
    scene
        .host
        .script_pages(FAYE, vec![PageStep::Gate(gate.clone())]);
    let (outcome, ()) = tokio::join!(scene.cycle(FAYE), async {
        gate.reached.notified().await;
        between(scene);
        gate.release.notify_one();
    });
    outcome
}

#[tokio::test]
async fn a_base_that_moves_during_the_poll_is_retried_and_not_replaced() {
    let scene = with_a_gap_to_recover_from().await;

    let outcome = move_the_base_during_the_poll(&scene, |scene| {
        // Another writer replaced the member's state at a later revision.
        let mut repo = HostRepo::new(1);
        repo.put(2, POST, "ein", post("Woof"));
        repo.put(3, POST, "swordfish", post("See you space cowboy"));
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "hammerhead", post("Bang"));
        let mut state = crate::space_set_hash::SetHashState::empty();
        let mut records = Vec::new();
        for (path, bytes) in repo.record_bytes() {
            let (collection, rkey) = path.split_once('/').unwrap();
            let (cid, value) = crate::space_record::decode_record(&bytes).unwrap();
            let path = crate::space_set_hash::RecordPath::parse(collection, rkey).unwrap();
            state.add(&crate::space_set_hash::set_hash_element(&path, &cid));
            records.push(crate::store::VerifiedSpaceRecord {
                path,
                cid,
                value: Some(value),
            });
        }
        scene
            .lifecycle
            .replace_verified_space_repo(
                &crate::store::VerifiedSpaceTarget {
                    boundary: BOUNDARY.to_owned(),
                    space_uri: SPACE.to_owned(),
                    actor_did: FAYE.to_owned(),
                    host: HOST.to_owned(),
                    generation: scene.target(FAYE).generation,
                },
                &MacVerifiedCommit::for_tests(FAYE, SPACE, &tid(5), state.digest()),
                &records,
                RETAINED,
                OBSERVED,
            )
            .unwrap();
    })
    .await;

    assert_eq!(outcome, VerifiedSyncOutcome::Retry);
    assert_eq!(
        scene.base_rev(FAYE),
        Some(tid(5)),
        "the other writer's state stands"
    );
    assert_eq!(scene.host.archives_requested(), 1, "retried, not replaced");
}

#[tokio::test]
async fn a_member_removed_during_the_poll_promotes_nothing() {
    let scene = with_a_gap_to_recover_from().await;

    let outcome = move_the_base_during_the_poll(&scene, |scene| {
        scene
            .lifecycle
            .replace_pds_space_members(
                BOUNDARY,
                vec![PdsSpaceMember {
                    did: JET.to_owned(),
                }],
                "2026-09-22T00:00:01.000Z",
            )
            .unwrap();
    })
    .await;

    assert_eq!(outcome, VerifiedSyncOutcome::Retry);
    assert!(
        scene.served_uris().is_empty(),
        "the departed member's posts are gone"
    );
    assert_eq!(scene.host.archives_requested(), 1);
}

#[tokio::test]
async fn a_member_re_enrolled_with_a_new_generation_starts_with_a_replacement() {
    let scene = with_a_gap_to_recover_from().await;
    let stale = scene.target(FAYE);

    let outcome = move_the_base_during_the_poll(&scene, |scene| {
        for members in [
            vec![PdsSpaceMember {
                did: JET.to_owned(),
            }],
            vec![
                PdsSpaceMember {
                    did: FAYE.to_owned(),
                },
                PdsSpaceMember {
                    did: JET.to_owned(),
                },
            ],
        ] {
            scene
                .lifecycle
                .replace_pds_space_members(BOUNDARY, members, "2026-09-22T00:00:01.000Z")
                .unwrap();
        }
    })
    .await;
    assert_eq!(outcome, VerifiedSyncOutcome::Retry);

    // A cycle still holding the old generation is turned away at the first
    // read of the base.
    assert_eq!(scene.cycle_target(&stale).await, VerifiedSyncOutcome::Retry);
    assert_eq!(
        scene.base(FAYE),
        None,
        "the new generation holds no state yet"
    );

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);
    assert_ne!(scene.target(FAYE).generation, stale.generation);
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
}

#[tokio::test]
async fn a_forged_boundary_in_a_record_changes_nothing_about_where_it_is_served() {
    let scene = Scene::new();
    scene.host.edit(FAYE, |repo| {
        repo.put(
            2,
            POST,
            "swordfish",
            json!({
                "$type": POST,
                "text": "See you space cowboy",
                "createdAt": "1998-04-03T00:00:00.000Z",
                "boundary": {
                    "$type": "zone.stratos.boundary.defs#domains",
                    "values": [{ "$type": "zone.stratos.boundary.defs#domain", "value": "leadership" }],
                },
            }),
        );
    });

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);

    assert_eq!(
        scene.served_uris(),
        [format!("{SPACE}/{FAYE}/{POST}/swordfish")]
    );
    let other = scene.lifecycle.read(|projection| {
        projection.served_posts("did:web:stratos.example.test/leadership", AS_OF)
    });
    assert!(other.is_empty(), "the claimed boundary serves nothing");
}

#[tokio::test]
async fn a_host_that_differs_from_the_stored_one_replaces_from_the_new_host_and_stores_it() {
    // The new host holds the same records at the same revision. Nothing has
    // changed, yet the stored host is not this one, so the whole repo is read
    // from the new host.
    let scene = Scene::with_a_base().await;
    let mirror = TestHost::serving(SPACE);
    let mut repo = HostRepo::new(1);
    repo.put(2, POST, "ein", post("Woof"));
    repo.put(3, POST, "swordfish", post("See you space cowboy"));
    mirror.hold(FAYE, repo);
    scene.source.host_at(OTHER_HOST, Arc::clone(&mirror));
    let moved = PdsPollTarget {
        host: OTHER_HOST.to_owned(),
        ..scene.target(FAYE)
    };

    assert_eq!(
        scene.cycle_target(&moved).await,
        VerifiedSyncOutcome::Replaced
    );

    assert_eq!(scene.base(FAYE).unwrap().host, OTHER_HOST);
    assert_eq!(mirror.archives_requested(), 1);
    assert_eq!(
        scene.host.archives_requested(),
        1,
        "the old host was not asked"
    );
    assert_eq!(scene.base_rev(FAYE), Some(tid(3)));

    // The next cycle at the new host has nothing to do.
    assert_eq!(
        scene.cycle_target(&moved).await,
        VerifiedSyncOutcome::Unchanged
    );
}

#[tokio::test]
async fn a_host_with_other_contents_and_no_oplog_replaces_from_the_new_host() {
    let scene = Scene::with_a_base().await;
    let successor = TestHost::serving(SPACE);
    let mut repo = HostRepo::new(1);
    repo.put(2, POST, "ein", post("Woof"));
    repo.put(5, POST, "hammerhead", post("Bang"));
    repo.forget_oplog();
    successor.hold(FAYE, repo);
    scene.source.host_at(OTHER_HOST, Arc::clone(&successor));
    let moved = PdsPollTarget {
        host: OTHER_HOST.to_owned(),
        ..scene.target(FAYE)
    };

    assert_eq!(
        scene.cycle_target(&moved).await,
        VerifiedSyncOutcome::Replaced
    );

    assert_eq!(scene.base(FAYE).unwrap().host, OTHER_HOST);
    assert_eq!(scene.base_rev(FAYE), Some(tid(5)));
    assert_eq!(
        scene.served_uris(),
        [
            format!("{SPACE}/{FAYE}/{POST}/ein"),
            format!("{SPACE}/{FAYE}/{POST}/hammerhead")
        ]
    );
}

fn digest_on(host: &TestHost, did: &str) -> [u8; 32] {
    let mut digest = [0; 32];
    host.edit(did, |repo| digest = repo.digest());
    digest
}

// A mirror at `OTHER_HOST` holding `repo` for Faye, and the target that names it.
fn moved_to_a_mirror(scene: &Scene, repo: HostRepo) -> (Arc<TestHost>, PdsPollTarget) {
    let mirror = TestHost::serving(SPACE);
    mirror.hold(FAYE, repo);
    scene.source.host_at(OTHER_HOST, Arc::clone(&mirror));
    let moved = PdsPollTarget {
        host: OTHER_HOST.to_owned(),
        ..scene.target(FAYE)
    };
    (mirror, moved)
}

#[tokio::test]
async fn a_mirror_at_a_lower_revision_with_the_same_records_replaces_and_its_host_and_revision_are_stored()
 {
    let scene = Scene::with_a_base().await;
    let (mirror, moved) = moved_to_a_mirror(&scene, the_base_records_at_revisions_one_and_two());
    assert_eq!(digest_on(&mirror, FAYE), scene.base_digest(FAYE));

    assert_eq!(
        scene.cycle_target(&moved).await,
        VerifiedSyncOutcome::Replaced
    );

    let base = scene.base(FAYE).unwrap();
    assert_eq!(base.host, OTHER_HOST);
    assert_eq!(base.rev, tid(2));
    assert!(
        mirror.pages_requested(FAYE).is_empty(),
        "nothing is polled from a host the base did not come from"
    );
    assert_eq!(mirror.archives_requested(), 1);
    assert_eq!(
        scene.cycle_target(&moved).await,
        VerifiedSyncOutcome::Unchanged
    );
}

// A page the revision bounds refuse: each op is at the base's revision 3.
fn a_page_with_its_ops_at_the_base_revision(host: &TestHost) -> PageStep {
    let mut ops: Vec<Value> = Vec::new();
    let mut commit_rev = String::new();
    host.edit(FAYE, |repo| {
        ops = repo
            .ops_since(Some(&tid(3)))
            .iter()
            .map(|op| op.as_wire())
            .collect();
        commit_rev = repo.rev().to_owned();
    });
    for op in &mut ops {
        op["rev"] = json!(tid(3));
    }
    PageStep::Written {
        ops,
        cursor: None,
        commit_rev,
        commit_data: digest_on(host, FAYE),
        padding_bytes: 0,
    }
}

#[tokio::test]
async fn a_stored_host_or_generation_other_than_the_targets_is_replaced_before_any_page_is_read() {
    for case in ["another host", "another generation"] {
        let scene = Scene::with_a_base().await;
        let (host, target) = match case {
            "another host" => {
                let mut repo = HostRepo::new(1);
                repo.put(2, POST, "ein", post("Woof"));
                repo.put(3, POST, "swordfish", post("See you space cowboy"));
                moved_to_a_mirror(&scene, repo)
            }
            _ => {
                let target = scene.target(FAYE);
                scene.lifecycle.read(|projection| {
                    projection.rewrite_stored_space_generation(SPACE, FAYE, target.generation + 1)
                });
                (Arc::clone(&scene.host), target)
            }
        };
        host.edit(FAYE, |repo| {
            repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        });
        let step = a_page_with_its_ops_at_the_base_revision(&host);
        host.script_pages(FAYE, vec![step]);

        assert_eq!(
            scene.cycle_target(&target).await,
            VerifiedSyncOutcome::Replaced,
            "{case}"
        );

        assert!(host.pages_requested(FAYE).is_empty(), "{case}: no page");
        let base = scene.base(FAYE).unwrap();
        assert_eq!(base.host, target.host, "{case}");
        assert_eq!(base.generation, target.generation, "{case}");
        assert_eq!(base.rev, tid(4), "{case}");
        assert_eq!(base.state.digest(), digest_on(&host, FAYE), "{case}");
    }
}

#[tokio::test]
async fn a_failed_replacement_after_a_host_change_or_a_host_gone_back_cools_down_as_any_other() {
    for case in ["a host change", "a host gone back"] {
        let scene = Scene::with_a_base().await;
        let (host, target) = match case {
            "a host change" => {
                moved_to_a_mirror(&scene, the_base_records_at_revisions_one_and_two())
            }
            _ => {
                scene
                    .host
                    .hold(FAYE, the_base_records_at_revisions_one_and_two());
                (Arc::clone(&scene.host), scene.target(FAYE))
            }
        };
        host.script_archives(
            FAYE,
            vec![ArchiveStep::Refused {
                status: 500,
                code: None,
            }],
        );
        let archives_before = host.archives_requested();
        let before = scene.snapshot();

        assert_eq!(
            scene.cycle_target(&target).await,
            VerifiedSyncOutcome::Failed(FailureReason::Other),
            "{case}"
        );
        assert_eq!(
            host.archives_requested(),
            archives_before + 1,
            "{case}: one replacement in the cycle"
        );

        assert_eq!(
            scene.cycle_target(&target).await,
            VerifiedSyncOutcome::Failed(FailureReason::ReplacementCooldown),
            "{case}"
        );
        assert_eq!(
            host.archives_requested(),
            archives_before + 1,
            "{case}: no archive request during the cooldown"
        );
        assert_eq!(scene.snapshot(), before, "{case}");
    }
}

#[tokio::test]
async fn a_failed_replacement_is_not_tried_again_until_ten_minutes_have_passed() {
    let scene = Scene::new();
    scene.host.edit(FAYE, |repo| {
        repo.put(2, POST, "ein", post("Woof"));
    });
    scene.host.script_archives(
        FAYE,
        vec![ArchiveStep::Refused {
            status: 500,
            code: None,
        }],
    );

    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::Other)
    );
    assert_eq!(scene.host.archives_requested(), 1);

    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::ReplacementCooldown)
    );
    assert_eq!(
        scene.host.archives_requested(),
        1,
        "no archive request during the cooldown"
    );

    scene
        .clock
        .advance(SPACE_REPLACEMENT_COOLDOWN - Duration::from_secs(1));
    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::ReplacementCooldown)
    );
    assert_eq!(scene.host.archives_requested(), 1);

    scene.clock.advance(Duration::from_secs(1));
    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);
    assert_eq!(
        scene.host.archives_requested(),
        2,
        "after ten minutes it asks again"
    );
}

#[tokio::test]
async fn incremental_polls_continue_while_a_replacement_cools_down() {
    let scene = with_a_gap_to_recover_from().await;
    scene
        .host
        .script_pages(FAYE, vec![PageStep::WrongDigest([9; 32])]);
    scene.host.script_archives(
        FAYE,
        vec![ArchiveStep::Refused {
            status: 500,
            code: None,
        }],
    );
    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::Other)
    );

    // The host answers honestly again: the poll promotes without a replacement.
    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);
    assert_eq!(scene.host.archives_requested(), 2);

    // A second gap inside the cooldown cannot be recovered from yet.
    scene.host.edit(FAYE, |repo| {
        repo.put(5, POST, "hammerhead", post("Bang"));
    });
    scene
        .host
        .script_pages(FAYE, vec![PageStep::WrongDigest([9; 32])]);
    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::ReplacementCooldown)
    );
    assert_eq!(scene.host.archives_requested(), 2);
}

#[tokio::test]
async fn a_cooldown_is_per_target() {
    let scene = Scene::new();
    scene.host.edit(FAYE, |repo| {
        repo.put(2, POST, "ein", post("Woof"));
    });
    scene.host.edit(JET, |repo| {
        repo.put(2, POST, "bebop", post("Spike"));
    });
    scene.host.script_archives(
        FAYE,
        vec![ArchiveStep::Refused {
            status: 500,
            code: None,
        }],
    );
    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::Other)
    );

    assert_eq!(scene.cycle(JET).await, VerifiedSyncOutcome::Replaced);
}

#[tokio::test]
async fn at_most_one_replacement_runs_per_target_in_a_cycle() {
    // A poll that needs a replacement whose archive then fails the digest does
    // not read the archive a second time.
    let scene = with_a_gap_to_recover_from().await;
    scene
        .host
        .script_pages(FAYE, vec![PageStep::WrongDigest([9; 32])]);
    scene
        .host
        .script_archives(FAYE, vec![ArchiveStep::WrongDigest([8; 32])]);

    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::Digest)
    );

    assert_eq!(
        scene.host.archives_requested(),
        2,
        "the first sync and one replacement"
    );
    assert_eq!(pages_of(&scene, FAYE).len(), 1);
}

#[tokio::test]
async fn two_targets_that_both_need_a_replacement_never_have_two_archive_requests_in_flight() {
    let scene = Scene::new();
    scene.host.edit(FAYE, |repo| {
        repo.put(2, POST, "ein", post("Woof"));
    });
    scene.host.edit(JET, |repo| {
        repo.put(2, POST, "bebop", post("Spike"));
    });
    let gate = Gate::new();
    scene
        .host
        .script_archives(FAYE, vec![ArchiveStep::Gate(gate.clone())]);

    let (faye, jet, ()) = tokio::join!(scene.cycle(FAYE), scene.cycle(JET), async {
        gate.reached.notified().await;
        // Faye's archive is held open. Give Jet's cycle every chance to ask.
        for _ in 0..500 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            scene.host.archives_requested(),
            1,
            "Jet's archive was not requested while Faye's was in flight"
        );
        gate.release.notify_one();
    });

    assert_eq!(faye, VerifiedSyncOutcome::Replaced);
    assert_eq!(jet, VerifiedSyncOutcome::Replaced);
    assert_eq!(scene.host.archives_requested(), 2);
    assert_eq!(scene.host.most_archives_in_flight(), 1);
}

#[tokio::test]
async fn a_second_cycle_for_the_same_target_waits_for_the_first() {
    let scene = Scene::with_a_base().await;
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
    });
    let gate = Gate::new();
    scene
        .host
        .script_pages(FAYE, vec![PageStep::Gate(gate.clone())]);

    let (first, second, ()) = tokio::join!(scene.cycle(FAYE), scene.cycle(FAYE), async {
        gate.reached.notified().await;
        for _ in 0..200 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            pages_of(&scene, FAYE).len(),
            1,
            "one poll at a time per target"
        );
        gate.release.notify_one();
    });

    assert_eq!(
        [first, second]
            .iter()
            .filter(|outcome| **outcome == VerifiedSyncOutcome::Promoted)
            .count(),
        1
    );
    assert!(scene.synchronizer.target_locks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_deadline_stops_a_slow_second_page_and_nothing_is_written() {
    let scene = Scene::with_a_base_and_limits(SyncLimits {
        deadline: Duration::from_millis(400),
        ..SyncLimits::default()
    })
    .await;
    scene.host.set_page_size(1);
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "hammerhead", post("Bang"));
    });
    scene
        .host
        .script_pages(FAYE, vec![PageStep::Honest, PageStep::Hang]);
    let before = scene.snapshot();

    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::Deadline)
    );

    assert_eq!(scene.snapshot(), before);
    assert_eq!(pages_of(&scene, FAYE).len(), 2);
}

#[tokio::test]
async fn a_replacement_that_runs_out_of_time_counts_as_failed_and_starts_the_cooldown() {
    let scene = Scene::with_limits(SyncLimits {
        deadline: Duration::from_millis(400),
        ..SyncLimits::default()
    });
    scene.host.edit(FAYE, |repo| {
        repo.put(2, POST, "ein", post("Woof"));
    });
    scene.host.script_archives(FAYE, vec![ArchiveStep::Hang]);

    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::Deadline)
    );
    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::ReplacementCooldown)
    );
    assert_eq!(scene.host.archives_requested(), 1);
}

#[tokio::test]
async fn a_target_whose_deadline_passes_while_it_waits_for_the_replacement_slot_fails_and_writes_nothing()
 {
    let scene = Scene::with_limits(SyncLimits {
        deadline: Duration::from_millis(400),
        ..SyncLimits::default()
    });
    scene.host.edit(JET, |repo| {
        repo.put(2, POST, "bebop", post("Spike"));
    });
    assert_eq!(scene.cycle(JET).await, VerifiedSyncOutcome::Replaced);
    // A gap in Jet's oplog, so Jet's next poll needs a replacement.
    scene.host.edit(JET, |repo| {
        repo.put(3, POST, "redtail", post("Cowboy Bebop"));
        repo.forget_oplog();
        repo.put(4, POST, "hammerhead", post("Bang"));
    });
    scene.host.edit(FAYE, |repo| {
        repo.put(2, POST, "ein", post("Woof"));
    });
    let jet_page = Gate::new();
    scene
        .host
        .script_pages(JET, vec![PageStep::Gate(jet_page.clone())]);
    let faye_archive = Gate::new();
    scene
        .host
        .script_archives(FAYE, vec![ArchiveStep::Gate(faye_archive.clone())]);
    let before = scene.snapshot();
    let jet_done = AtomicBool::new(false);
    let jet_finished = tokio::sync::Notify::new();

    let (jet, faye, ()) = tokio::join!(
        async {
            let outcome = scene.cycle(JET).await;
            jet_done.store(true, Ordering::SeqCst);
            jet_finished.notify_one();
            outcome
        },
        async {
            jet_page.reached.notified().await;
            // Jet's deadline is already set. Faye's is set after this, an hour
            // later, so only Jet's can pass while Faye holds the slot.
            scene.clock.advance(Duration::from_secs(3_600));
            scene.cycle(FAYE).await
        },
        async {
            faye_archive.reached.notified().await;
            assert!(
                !jet_done.load(Ordering::SeqCst),
                "Jet's cycle was still running when Faye took the slot"
            );
            jet_page.release.notify_one();
            tokio::select! {
                biased;
                () = jet_finished.notified() => {}
                () = tokio::time::sleep(Duration::from_secs(2)) => {
                    panic!("Jet's deadline did not end its wait for the slot")
                }
            }
            assert_eq!(scene.snapshot(), before, "Jet wrote nothing");
            assert_eq!(
                scene.host.archives_requested(),
                2,
                "Jet's first sync and Faye's, none for Jet while Faye's was open"
            );
            faye_archive.release.notify_one();
        },
    );

    assert_eq!(jet, VerifiedSyncOutcome::Failed(FailureReason::Deadline));
    assert_eq!(faye, VerifiedSyncOutcome::Replaced);
    assert_eq!(scene.host.most_archives_in_flight(), 1);
    assert_eq!(pages_of(&scene, JET).len(), 1);

    // No cooldown was started: with the slot free, Jet's next cycle replaces.
    assert_eq!(scene.cycle(JET).await, VerifiedSyncOutcome::Replaced);
    assert_eq!(scene.host.archives_requested(), 3);
    assert_eq!(scene.base_digest(JET), scene.host_digest(JET));
}

#[test]
fn the_configured_limits_are_the_ones_the_synchronizer_starts_with() {
    let limits = SyncLimits::default();
    assert_eq!(limits.deadline, SPACE_TARGET_DEADLINE);
    assert_eq!(limits.cooldown, SPACE_REPLACEMENT_COOLDOWN);
    assert_eq!(limits.ops, 1_000);
    assert_eq!(limits.body_bytes, 16 * 1024 * 1024);
    assert_eq!(limits.values, 2_000_000);
}

#[test]
fn each_refusal_of_a_promotion_is_recovered_retried_or_failed_as_the_rules_say() {
    for error in [
        StoreError::SpaceRepoFenced,
        StoreError::SpaceRepoPreviousMismatch,
        StoreError::SpaceRepoDigestMismatch,
    ] {
        assert_eq!(
            promotion_refusal(&error),
            PollEnd::NeedsReplacement,
            "{error:?}"
        );
    }
    for error in [
        StoreError::SpaceRepoBaseMoved,
        StoreError::UnauthorizedSpaceMember,
    ] {
        assert_eq!(
            promotion_refusal(&error),
            PollEnd::Finished(VerifiedSyncOutcome::Retry),
            "{error:?}"
        );
    }
    assert_eq!(
        promotion_refusal(&StoreError::SpaceRepoOverBudget),
        PollEnd::Finished(VerifiedSyncOutcome::Failed(FailureReason::RepoOverBudget))
    );
    assert_eq!(
        promotion_refusal(&StoreError::SpaceRepoInvalid),
        PollEnd::Finished(VerifiedSyncOutcome::Failed(FailureReason::Store))
    );
}

#[test]
fn each_refusal_of_a_replacement_fails_retries_or_is_a_digest_as_the_rules_say() {
    for (error, expected) in [
        (
            StoreError::SpaceRepoDigestMismatch,
            VerifiedSyncOutcome::Failed(FailureReason::Digest),
        ),
        (
            StoreError::SpaceRepoOverBudget,
            VerifiedSyncOutcome::Failed(FailureReason::RepoOverBudget),
        ),
        (
            StoreError::SpaceRepoInvalid,
            VerifiedSyncOutcome::Failed(FailureReason::RecordRefused),
        ),
        (
            StoreError::UnauthorizedSpaceMember,
            VerifiedSyncOutcome::Retry,
        ),
        (StoreError::SpaceRepoBaseMoved, VerifiedSyncOutcome::Retry),
        (
            StoreError::SpaceRepoFenced,
            VerifiedSyncOutcome::Failed(FailureReason::Store),
        ),
        (
            StoreError::SpaceRepoPreviousMismatch,
            VerifiedSyncOutcome::Failed(FailureReason::Store),
        ),
    ] {
        assert_eq!(replacement_refusal(&error), expected, "{error:?}");
    }
}

#[tokio::test]
async fn each_page_of_a_poll_and_the_archive_are_sent_with_a_key_share_of_their_own() {
    let scene = Scene::with_a_base().await;
    scene.host.set_page_size(1);
    scene.host.edit(FAYE, |repo| {
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
        repo.put(5, POST, "hammerhead", post("Bang"));
    });
    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);

    let shares = scene.host.key_shares();
    assert_eq!(shares.len(), 1 + 3, "an archive and three pages");
    let distinct: std::collections::BTreeSet<_> = shares.iter().collect();
    assert_eq!(distinct.len(), shares.len());
}

#[tokio::test]
async fn a_host_that_went_back_to_an_older_revision_is_replaced_from_without_a_revision_floor() {
    let scene = Scene::with_a_base().await;
    // The host was restored from a backup: it is at revision 2 with other
    // contents than the member's base at revision 3.
    scene.host.hold(FAYE, {
        let mut repo = HostRepo::new(1);
        repo.put(2, POST, "hammerhead", post("Bang"));
        repo
    });

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);

    assert_eq!(
        scene.base_rev(FAYE),
        Some(tid(2)),
        "the base went down with the host"
    );
    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
    assert_eq!(
        scene.served_uris(),
        [format!("{SPACE}/{FAYE}/{POST}/hammerhead")]
    );
}

#[tokio::test]
async fn a_host_at_the_held_revision_with_other_contents_is_replaced_and_not_taken_for_unchanged() {
    let scene = Scene::with_a_base().await;
    // No op since the base and the same revision, but the state the commit
    // covers is not the one held.
    scene.host.hold(FAYE, {
        let mut repo = HostRepo::new(1);
        repo.put(3, POST, "hammerhead", post("Bang"));
        repo
    });

    assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);

    assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
    assert_eq!(
        scene.served_uris(),
        [format!("{SPACE}/{FAYE}/{POST}/hammerhead")]
    );
}

#[tokio::test]
async fn a_replacement_dropped_part_way_counts_as_failed_and_starts_the_cooldown() {
    let scene = Scene::new();
    scene.host.edit(FAYE, |repo| {
        repo.put(2, POST, "ein", post("Woof"));
    });
    let gate = Gate::new();
    scene
        .host
        .script_archives(FAYE, vec![ArchiveStep::Gate(gate.clone())]);

    tokio::select! {
        outcome = scene.cycle(FAYE) => panic!("the cycle finished: {outcome:?}"),
        () = gate.reached.notified() => {}
    }

    assert_eq!(scene.base(FAYE), None);
    assert_eq!(
        scene.cycle(FAYE).await,
        VerifiedSyncOutcome::Failed(FailureReason::ReplacementCooldown)
    );
    assert_eq!(scene.host.archives_requested(), 1);
}

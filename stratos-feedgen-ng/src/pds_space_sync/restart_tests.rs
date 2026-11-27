use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::*;

const TEST: &str = "pds_space_sync::tests::restart_tests::a_killed_poll_process_restarts_from_its_persisted_verified_base";
const DIRECTORY: &str = "STRATOS_FEEDGEN_RESTART_TEST_DIRECTORY";
const PHASE: &str = "STRATOS_FEEDGEN_RESTART_TEST_PHASE";

struct FixtureDirectory(PathBuf);

impl FixtureDirectory {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "stratos-feedgen-restart-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct PollProcess(Child);

impl PollProcess {
    fn start(path: &Path, phase: &str) -> Self {
        Self(
            Command::new(env::current_exe().unwrap())
                .args([TEST, "--exact", "--nocapture"])
                .env(DIRECTORY, path)
                .env(PHASE, phase)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }

    async fn finished(&mut self) -> ExitStatus {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Some(exit) = self.0.try_wait().unwrap() {
                    return exit;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("poll process did not finish")
    }
}

impl Drop for PollProcess {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn scene(path: &Path) -> Scene {
    let mut store_path = path.to_path_buf();
    store_path.push("projection.sqlite");
    let store = EncryptedStore::open(&store_path, StorageKey::from_bytes([7; 32])).unwrap();
    let scene = Scene::with_store(store, SyncLimits::default());
    scene.host.edit(FAYE, |repo| {
        repo.put(2, POST, "ein", post("Woof"));
        repo.put(3, POST, "swordfish", post("See you space cowboy"));
        repo.put(4, POST, "redtail", post("Cowboy Bebop"));
    });
    scene.host.edit(JET, |repo| {
        repo.put(2, POST, "bebop", post("Spike"));
    });
    scene.host.set_page_size(1);
    scene
}

#[tokio::test]
async fn a_killed_poll_process_restarts_from_its_persisted_verified_base() {
    if let Some(directory) = env::var_os(DIRECTORY) {
        let directory = Path::new(&directory);
        let scene = scene(directory);
        assert_eq!(scene.base_rev(FAYE), Some(tid(3)));
        match env::var(PHASE).as_deref() {
            Ok("hold") => {
                let gate = Gate::new();
                scene
                    .host
                    .script_pages(FAYE, vec![PageStep::Honest, PageStep::Gate(gate.clone())]);
                let poll = scene.cycle(FAYE);
                tokio::pin!(poll);
                tokio::select! {
                    outcome = &mut poll => panic!("finished before the page barrier: {outcome:?}"),
                    () = gate.reached.notified() => {}
                }
                assert_eq!(
                    pages_of(&scene, FAYE),
                    [(Some(tid(3)), None), (Some(tid(3)), Some("1".to_owned()))]
                );
                fs::write(directory.join("continuation-held"), []).unwrap();
                let outcome = poll.await;
                panic!("reached the terminal revision while held: {outcome:?}");
            }
            Ok("resume") => {
                assert_eq!(scene.cycle(FAYE).await, VerifiedSyncOutcome::Promoted);
                assert_eq!(
                    pages_of(&scene, FAYE),
                    [(Some(tid(3)), None), (Some(tid(3)), Some("1".to_owned()))]
                );
                assert_eq!(scene.base_rev(FAYE), Some(tid(4)));
                assert_eq!(scene.base_digest(FAYE), scene.host_digest(FAYE));
            }
            _ => panic!("unrecognized restart fixture phase"),
        }
        return;
    }

    let directory = FixtureDirectory::new();
    let seeded = scene(&directory.0);
    seeded.host.edit(FAYE, |repo| {
        let mut verified_base = HostRepo::new(1);
        verified_base.put(2, POST, "ein", post("Woof"));
        verified_base.put(3, POST, "swordfish", post("See you space cowboy"));
        *repo = verified_base;
    });
    assert_eq!(seeded.cycle(FAYE).await, VerifiedSyncOutcome::Replaced);
    assert_eq!(seeded.cycle(JET).await, VerifiedSyncOutcome::Replaced);
    let before = seeded.snapshot();
    let peer = seeded.base(JET);
    let mut expected_feed = seeded.served_uris();
    drop(seeded);

    let mut held = PollProcess::start(&directory.0, "hold");
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            assert!(
                held.0.try_wait().unwrap().is_none(),
                "poll process exited before the kill"
            );
            if directory.0.join("continuation-held").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("poll process did not reach the continuation");
    held.0.kill().unwrap();
    assert!(!held.finished().await.success());

    let offline = scene(&directory.0);
    assert_eq!(offline.snapshot(), before);
    assert_eq!(offline.base_rev(FAYE), Some(tid(3)));
    drop(offline);

    let mut fresh = PollProcess::start(&directory.0, "resume");
    assert!(fresh.finished().await.success());
    let reopened = scene(&directory.0);
    assert_eq!(reopened.base(FAYE).unwrap().record_count, 3);
    assert_eq!(reopened.base_rev(FAYE), Some(tid(4)));
    assert_eq!(reopened.base(JET), peer);
    expected_feed.push(format!("{SPACE}/{FAYE}/{POST}/redtail"));
    expected_feed.sort_unstable();
    let mut actual_feed = reopened.served_uris();
    actual_feed.sort_unstable();
    assert_eq!(actual_feed, expected_feed);
}

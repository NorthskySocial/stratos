use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use rusqlite::Connection;
use serde::Deserialize;

use super::{
    ActorEnrollment, ActorPage, EncryptedStore, MAX_ACTOR_ENROLLMENT_PAGE, ProjectionCompaction,
    ProjectionPost, StorageKey, StoreError,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedOrderFixture {
    version: u8,
    boundary: String,
    limit: u16,
    posts: Vec<FeedOrderPost>,
    expected_pages: Vec<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedOrderPost {
    uri: String,
    sort_at: String,
}

fn key(byte: u8) -> StorageKey {
    StorageKey::from_bytes([byte; 32])
}

fn spike_post() -> ProjectionPost {
    ProjectionPost {
        uri: "at://did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string(),
        author_did: "did:plc:spikespiegel".to_string(),
        cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        sort_at: "1998-04-03T00:00:00.000Z".to_string(),
        indexed_at: "1998-04-03T00:00:01.000Z".to_string(),
        retained_at: "1998-04-04T00:00:00.000Z".to_string(),
        record_json: br#"{"text":"Bang"}"#.to_vec(),
        blob_refs_json: b"[]".to_vec(),
        boundaries: vec!["bebop".to_string()],
    }
}

#[test]
fn post_order_accepts_valid_utc_microseconds() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let mut post = spike_post();
    post.sort_at = "1998-04-03T00:00:00.123456+00:00".to_owned();
    store
        .apply_actor_page(actor_page(1, vec![post], Vec::new()))
        .unwrap();
    assert_eq!(
        store
            .list_posts_by_boundary("bebop", None, 10, "1998-04-03T00:00:01.000Z")
            .unwrap()
            .posts
            .len(),
        1
    );
}

fn space_post() -> ProjectionPost {
    let mut post = spike_post();
    post.uri = "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string();
    post
}

fn actor_page(sequence: u64, upserts: Vec<ProjectionPost>, deletes: Vec<String>) -> ActorPage {
    ActorPage {
        authority_did: "did:web:stratos.example".to_string(),
        actor_did: "did:plc:spikespiegel".to_string(),
        sequence,
        upserts,
        deletes,
        updated_at: "1998-04-03T00:00:02.000Z".to_string(),
        interactions: crate::store::InteractionChanges::default(),
    }
}

fn temporary_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("stratos-feedgen-ng-{name}-{}", std::process::id()))
}

fn write_secret_file(name: &str, contents: &[u8], mode: u32) -> PathBuf {
    let path = temporary_path(name);
    let _ = fs::remove_file(&path);
    fs::write(&path, contents).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
    path
}

#[test]
fn opens_only_when_sqlcipher_is_available() {
    let store = EncryptedStore::open_memory(key(7)).unwrap();
    assert!(!store.cipher_version().unwrap().is_empty());
}

#[test]
fn reconciles_actor_enrollment_shrink_and_unenrollment_atomically() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let mut post = spike_post();
    post.boundaries = vec!["bebop".to_owned(), "crew".to_owned()];
    store
        .apply_actor_page(actor_page(1, vec![post], Vec::new()))
        .unwrap();
    let initial = ActorEnrollment {
        did: "did:plc:spikespiegel".to_owned(),
        boundaries: vec!["bebop".to_owned(), "crew".to_owned()],
        observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
    };
    assert!(
        store
            .reconcile_actor_enrollment(
                "did:plc:spikespiegel",
                "1998-04-03T00:00:00.000Z",
                Some(initial),
            )
            .unwrap()
            .removed_boundaries
            .is_empty()
    );
    store
            .connection
            .execute(
                "INSERT INTO source_coverage (authority_did, source_id, boundary, start_sequence, end_sequence, verified_at)
                 VALUES ('did:plc:authority', 'did:plc:spikespiegel', 'crew', 0, 1, '1998-04-03T00:00:00.000Z')",
                [],
            )
            .unwrap();
    store
            .connection
            .execute(
                "INSERT INTO suppression_marker (authority_did, source_id, uri, sequence)
                 VALUES ('did:plc:authority', 'did:plc:spikespiegel', 'at://did:plc:spikespiegel/zone.stratos.feed.post/spike', 1)",
                [],
            )
            .unwrap();

    let shrunk = ActorEnrollment {
        did: "did:plc:spikespiegel".to_owned(),
        boundaries: vec!["bebop".to_owned()],
        observed_at: "1998-04-03T00:00:01.000Z".to_owned(),
    };
    let result = store
        .reconcile_actor_enrollment(
            "did:plc:spikespiegel",
            "1998-04-03T00:00:01.000Z",
            Some(shrunk),
        )
        .unwrap();
    assert_eq!(result.removed_boundaries, ["crew"]);
    assert_eq!(result.removed_posts, 0);
    assert_eq!(store.list_actor_enrollments_page(None, 1).unwrap().len(), 1);
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM post_boundary WHERE boundary = 'crew'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM source_coverage WHERE boundary = 'crew'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );

    let result = store
        .reconcile_actor_enrollment("did:plc:spikespiegel", "1998-04-03T00:00:02.000Z", None)
        .unwrap();
    assert!(!result.enrolled);
    assert_eq!(result.removed_posts, 1);
    assert!(
        store
            .list_actor_enrollments_page(None, 1)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM actor_cursor", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM source_coverage", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM suppression_marker", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn rejects_a_stale_unenrollment_after_a_later_enrollment() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let enrolled = ActorEnrollment {
        did: "did:plc:spikespiegel".to_owned(),
        boundaries: vec!["bebop".to_owned()],
        observed_at: "1998-04-03T00:00:02.000Z".to_owned(),
    };
    store
        .reconcile_actor_enrollment(
            "did:plc:spikespiegel",
            "1998-04-03T00:00:02.000Z",
            Some(enrolled),
        )
        .unwrap();

    assert!(matches!(
        store.reconcile_actor_enrollment("did:plc:spikespiegel", "1998-04-03T00:00:01.000Z", None,),
        Err(StoreError::StaleCursor)
    ));
    assert_eq!(store.list_actor_enrollments_page(None, 1).unwrap().len(), 1);
}

#[test]
fn rejects_a_conflicting_enrollment_at_the_current_observation_time() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let observed_at = "1998-04-03T00:00:02.000Z";
    store
        .reconcile_actor_enrollment(
            "did:plc:spikespiegel",
            observed_at,
            Some(ActorEnrollment {
                did: "did:plc:spikespiegel".to_owned(),
                boundaries: vec!["bebop".to_owned()],
                observed_at: observed_at.to_owned(),
            }),
        )
        .unwrap();

    assert!(matches!(
        store.reconcile_actor_enrollment("did:plc:spikespiegel", observed_at, None),
        Err(StoreError::EnrollmentConflict)
    ));
    assert_eq!(
        store.list_actor_enrollments_page(None, 1).unwrap()[0].boundaries,
        ["bebop"]
    );
}

#[test]
fn bounds_actor_enrollment_pages() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    for (did, boundary, observed_at) in [
        ("did:plc:spike", "bebop", "1998-04-03T00:00:00.000Z"),
        ("did:plc:jet", "crew", "1998-04-03T00:00:01.000Z"),
    ] {
        store
            .reconcile_actor_enrollment(
                did,
                observed_at,
                Some(ActorEnrollment {
                    did: did.to_owned(),
                    boundaries: vec![boundary.to_owned()],
                    observed_at: observed_at.to_owned(),
                }),
            )
            .unwrap();
    }

    let first_page = store.list_actor_enrollments_page(None, 1).unwrap();
    assert_eq!(first_page.len(), 1);
    let second_page = store
        .list_actor_enrollments_page(Some(&first_page[0].did), 1)
        .unwrap();
    assert_eq!(second_page.len(), 1);
    assert_ne!(first_page[0].did, second_page[0].did);
    assert!(matches!(
        store.list_actor_enrollments_page(None, 0),
        Err(StoreError::InvalidProjectionMutation)
    ));
    assert!(matches!(
        store.list_actor_enrollments_page(None, MAX_ACTOR_ENROLLMENT_PAGE + 1),
        Err(StoreError::InvalidProjectionMutation)
    ));
}

#[test]
fn interrupt_handle_stops_a_running_query() {
    let store = EncryptedStore::open_memory(key(7)).unwrap();
    let interrupt = store.interrupt_handle();
    let (started_sender, started_receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        started_sender.send(()).unwrap();
        store
                .connection
                .query_row(
                    "WITH RECURSIVE counter(value) AS (VALUES(0) UNION ALL SELECT value + 1 FROM counter WHERE value < 1000000000) SELECT sum(value) FROM counter",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .is_err()
    });

    started_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !worker.is_finished() {
        assert!(
            Instant::now() < deadline,
            "query did not stop after interrupts"
        );
        interrupt.interrupt();
        thread::yield_now();
    }
    assert!(worker.join().unwrap());
}

#[test]
fn reopens_with_the_same_key_and_rejects_a_wrong_key() {
    let path = temporary_path("cipher-reopen.sqlite");
    let _ = fs::remove_file(&path);
    {
        let store = EncryptedStore::open(&path, key(7)).unwrap();
        assert!(!store.cipher_version().unwrap().is_empty());
        store
            .connection
            .execute(
                "INSERT INTO retention_metadata (key, value) VALUES ('probe', 1)",
                [],
            )
            .unwrap();
    }
    let bytes = fs::read(&path).unwrap();
    assert_ne!(&bytes[..16], b"SQLite format 3\0");
    let reopened = EncryptedStore::open(&path, key(7)).unwrap();
    assert_eq!(
        reopened
            .connection
            .query_row(
                "SELECT value FROM retention_metadata WHERE key = 'probe'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    assert!(EncryptedStore::open(&path, key(8)).is_err());
    fs::remove_file(path).unwrap();
}

#[test]
fn rejects_a_plain_sqlite_file() {
    let path = temporary_path("plain.sqlite");
    let _ = fs::remove_file(&path);
    let plain = Connection::open(&path).unwrap();
    plain
        .execute("CREATE TABLE plain_state (id INTEGER PRIMARY KEY)", [])
        .unwrap();
    drop(plain);

    assert!(EncryptedStore::open(&path, key(7)).is_err());
    fs::remove_file(path).unwrap();
}

#[test]
fn redacts_storage_keys_in_debug_output() {
    assert_eq!(format!("{:?}", key(7)), "StorageKey([REDACTED])");
}

#[test]
fn redacts_underlying_storage_errors_in_debug_output() {
    let secret = "0707070707070707070707070707070707070707070707070707070707070707";
    let error = super::StoreError::Open(rusqlite::Error::InvalidParameterName(secret.to_string()));
    assert!(!format!("{error:?}").contains(secret));
}

#[test]
fn applies_posts_and_actor_cursor_in_one_transaction() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    store
        .apply_actor_page(actor_page(8, vec![spike_post()], Vec::new()))
        .unwrap();

    assert_eq!(
        store
            .connection
            .query_row("SELECT sequence FROM actor_cursor", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM post WHERE uri = ?1",
                ["at://did:plc:spikespiegel/zone.stratos.feed.post/see-you"],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT sort_at FROM post_boundary WHERE boundary = 'bebop'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "1998-04-03T00:00:00.000Z"
    );
}

#[test]
fn exposes_only_a_retained_post_with_its_authoritative_boundaries_for_blob_reads() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let mut post = spike_post();
    post.blob_refs_json = br#"[{\"cid\":\"bafyblob\",\"mimeType\":\"image/png\"}]"#.to_vec();
    store
        .apply_actor_page(actor_page(1, vec![post], Vec::new()))
        .unwrap();

    let blob_post = store
        .blob_post(
            "at://did:plc:spikespiegel/zone.stratos.feed.post/see-you",
            "1998-04-03T00:00:00.000Z",
        )
        .unwrap()
        .unwrap();
    assert_eq!(blob_post.author_did, "did:plc:spikespiegel");
    assert_eq!(blob_post.boundaries, ["bebop"]);
    assert_eq!(
        blob_post.blob_refs_json,
        br#"[{\"cid\":\"bafyblob\",\"mimeType\":\"image/png\"}]"#
    );
    assert!(
        store
            .blob_post(
                "at://did:plc:spikespiegel/zone.stratos.feed.post/see-you",
                "1998-04-04T00:00:00.000Z",
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn returns_actor_sync_state_only_while_the_actor_is_enrolled() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    assert!(
        store
            .actor_sync_state("did:web:stratos.example", "did:plc:spikespiegel")
            .unwrap()
            .is_none()
    );
    store
        .reconcile_actor_enrollment(
            "did:plc:spikespiegel",
            "1998-04-03T00:00:00.000Z",
            Some(ActorEnrollment {
                did: "did:plc:spikespiegel".to_owned(),
                boundaries: vec!["bebop".to_owned()],
                observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
            }),
        )
        .unwrap();
    store
        .apply_actor_page(actor_page(8, vec![spike_post()], Vec::new()))
        .unwrap();
    assert_eq!(
        store
            .actor_sync_state("did:web:stratos.example", "did:plc:spikespiegel")
            .unwrap()
            .unwrap()
            .cursor,
        Some(8)
    );
    store
        .reconcile_actor_enrollment("did:plc:spikespiegel", "1998-04-03T00:00:01.000Z", None)
        .unwrap();
    assert!(
        store
            .actor_sync_state("did:web:stratos.example", "did:plc:spikespiegel")
            .unwrap()
            .is_none()
    );
}

#[test]
fn rejects_a_stale_page_without_deleting_its_existing_projection() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let post = spike_post();
    store
        .apply_actor_page(actor_page(8, vec![post], Vec::new()))
        .unwrap();

    assert!(matches!(
        store.apply_actor_page(actor_page(
            7,
            Vec::new(),
            vec!["at://did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string()],
        )),
        Err(StoreError::StaleCursor)
    ));
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn rejects_posts_that_do_not_belong_to_the_cursor_actor() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let mut page = actor_page(8, vec![spike_post()], Vec::new());
    page.actor_did = "did:plc:fayevalentine".to_string();

    assert!(matches!(
        store.apply_actor_page(page),
        Err(StoreError::InvalidProjectionMutation)
    ));
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn removes_a_post_when_authority_withdraws_all_boundaries() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    store
        .apply_actor_page(actor_page(8, vec![spike_post()], Vec::new()))
        .unwrap();
    let mut withdrawn = spike_post();
    withdrawn.boundaries.clear();

    store
        .apply_actor_page(actor_page(9, vec![withdrawn], Vec::new()))
        .unwrap();

    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT sequence FROM actor_cursor", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        9
    );
}

#[test]
fn rejects_deletes_that_do_not_belong_to_the_cursor_actor() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let post = spike_post();
    store
        .apply_actor_page(actor_page(8, vec![post], Vec::new()))
        .unwrap();
    let mut page = actor_page(
        9,
        Vec::new(),
        vec!["at://did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string()],
    );
    page.actor_did = "did:plc:fayevalentine".to_string();

    assert!(matches!(
        store.apply_actor_page(page),
        Err(StoreError::InvalidProjectionMutation)
    ));
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn rejects_space_posts_from_the_actor_projection_path() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();

    assert!(matches!(
        store.apply_actor_page(actor_page(8, vec![space_post()], Vec::new())),
        Err(StoreError::InvalidProjectionMutation)
    ));
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn follows_the_shared_tied_timestamp_ordering_fixture() {
    let fixture: FeedOrderFixture = serde_json::from_str(include_str!(
        "../../../stratos-feedgen/testdata/conformance/v1/feed-order.json"
    ))
    .unwrap();
    assert_eq!(fixture.version, 1);
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let posts = fixture
        .posts
        .into_iter()
        .map(|value| ProjectionPost {
            uri: value.uri,
            sort_at: value.sort_at,
            retained_at: "2998-04-04T00:00:00.000Z".to_string(),
            ..spike_post()
        })
        .collect();
    store
        .apply_actor_page(actor_page(8, posts, Vec::new()))
        .unwrap();
    let mut cursor = None;
    for expected_uris in fixture.expected_pages {
        let page = store
            .list_posts_by_boundary(
                &fixture.boundary,
                cursor.as_ref(),
                fixture.limit,
                "2024-02-01T00:00:00.000Z",
            )
            .unwrap();
        assert_eq!(
            page.posts.iter().map(|post| &post.uri).collect::<Vec<_>>(),
            expected_uris.iter().collect::<Vec<_>>()
        );
        cursor = page.cursor;
    }
}

#[test]
fn never_lists_expired_posts_and_purges_them_with_boundaries() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let mut expired = spike_post();
    expired.retained_at = "1998-04-03T00:00:00.000Z".to_string();
    store
        .apply_actor_page(actor_page(8, vec![expired], Vec::new()))
        .unwrap();

    let page = store
        .list_posts_by_boundary("bebop", None, 50, "1998-04-03T12:00:00.000Z")
        .unwrap();
    assert!(page.posts.is_empty());
    assert_eq!(
        store.purge_expired("1998-04-03T12:00:00.000Z", 1).unwrap(),
        1
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM post_boundary", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn compaction_evicts_oldest_posts_until_the_projection_fits_its_byte_cap() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let mut oldest = spike_post();
    oldest.sort_at = "1998-04-03T00:00:00.000Z".to_owned();
    oldest.retained_at = "1998-05-03T00:00:00.000Z".to_owned();
    let mut newest = spike_post();
    newest.uri = "at://did:plc:spikespiegel/zone.stratos.feed.post/zebra".to_owned();
    newest.sort_at = "1998-04-04T00:00:00.000Z".to_owned();
    newest.retained_at = "1998-05-03T00:00:00.000Z".to_owned();
    store
        .apply_actor_page(actor_page(8, vec![oldest], Vec::new()))
        .unwrap();
    store
        .apply_actor_page(actor_page(9, vec![newest], Vec::new()))
        .unwrap();
    let total: i64 = store
        .connection
        .query_row("SELECT SUM(projection_bytes) FROM post", [], |row| {
            row.get(0)
        })
        .unwrap();

    assert_eq!(
        store
            .compact_projection(
                "1998-04-01T00:00:00.000Z",
                "1998-06-01T00:00:00.000Z",
                (total - 1) as u64,
                1,
            )
            .unwrap(),
        ProjectionCompaction {
            deleted: 1,
            has_more: false,
        }
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT uri FROM post", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "at://did:plc:spikespiegel/zone.stratos.feed.post/zebra"
    );
}

fn insert_post_counted_as(store: &EncryptedStore, rkey: &str, projection_bytes: i64) {
    store
        .connection
        .execute(
            "INSERT INTO post (uri, author_did, cid, sort_at, indexed_at, retained_at, projection_bytes, record_json, blob_refs_json, row_version)
             VALUES (?1, 'did:plc:spikespiegel', 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                     '1998-04-03T00:00:00.000Z', '1998-04-03T00:00:00.000Z', '1998-05-03T00:00:00.000Z', ?2, x'7b7d', x'5b5d', 0)",
            rusqlite::params![
                format!("at://did:plc:spikespiegel/zone.stratos.feed.post/{rkey}"),
                projection_bytes
            ],
        )
        .unwrap();
}

fn posts_held(store: &EncryptedStore) -> i64 {
    store
        .connection
        .query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0))
        .unwrap()
}

// A 6,500-byte post fits the 10,000-byte maximum but not the 6,000 bytes left
// beside a 4,000-byte reserve, so compaction evicts it.
#[test]
fn compaction_keeps_the_space_write_reserve_free_before_published_posts_fill_the_maximum() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    insert_post_counted_as(&store, "bang", 6_500);

    let result = store
        .compact_projection_with_reserve(
            "1998-04-01T00:00:00.000Z",
            "1998-06-01T00:00:00.000Z",
            10_000,
            1,
            4_000,
        )
        .unwrap();

    assert_eq!(result.deleted, 1);
    assert!(!result.has_more);
    assert_eq!(posts_held(&store), 0);
}

#[test]
fn compaction_without_an_explicit_reserve_keeps_half_the_maximum_free() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    insert_post_counted_as(&store, "bang", 6_000);

    let result = store
        .compact_projection(
            "1998-04-01T00:00:00.000Z",
            "1998-06-01T00:00:00.000Z",
            10_000,
            1,
        )
        .unwrap();

    assert_eq!(result.deleted, 1);
    assert_eq!(posts_held(&store), 0);
}

// An older build wrote its stage limits into retention metadata; the reserve
// comes from the configuration alone.
#[test]
fn compaction_ignores_the_stage_limits_an_older_build_left_in_retention_metadata() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    for (stale_key, value) in [
        ("stage_target_max_rows", 1),
        ("stage_global_max_rows", 1),
        ("stage_target_max_bytes", 1),
        ("stage_global_max_bytes", 9_999),
    ] {
        store
            .connection
            .execute(
                "INSERT INTO retention_metadata (key, value) VALUES (?1, ?2)",
                rusqlite::params![stale_key, value],
            )
            .unwrap();
    }
    insert_post_counted_as(&store, "bang", 5_000);

    let result = store
        .compact_projection_with_reserve(
            "1998-04-01T00:00:00.000Z",
            "1998-06-01T00:00:00.000Z",
            10_000,
            1,
            4_000,
        )
        .unwrap();

    assert_eq!(result.deleted, 0);
    assert_eq!(posts_held(&store), 1);
}

#[test]
fn compaction_refuses_a_reserve_that_is_zero_or_not_below_the_maximum() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    insert_post_counted_as(&store, "bang", 100);
    for reserve in [0, 10_000, 10_001] {
        assert!(
            matches!(
                store.compact_projection_with_reserve(
                    "1998-04-01T00:00:00.000Z",
                    "1998-06-01T00:00:00.000Z",
                    10_000,
                    1,
                    reserve,
                ),
                Err(StoreError::InvalidProjectionMutation)
            ),
            "{reserve}"
        );
    }
    assert_eq!(posts_held(&store), 1);
}

#[test]
fn compaction_applies_a_shortened_retention_policy_to_existing_posts() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let mut post = spike_post();
    post.retained_at = "1998-05-03T00:00:00.000Z".to_owned();
    store
        .apply_actor_page(actor_page(8, vec![post], Vec::new()))
        .unwrap();

    assert_eq!(
        store
            .compact_projection(
                "1998-04-03T00:00:00.000Z",
                "1998-04-04T00:00:00.000Z",
                u64::MAX / 2,
                1,
            )
            .unwrap()
            .deleted,
        1
    );
}

#[test]
fn boundary_purge_preserves_posts_still_scoped_to_another_boundary() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    let mut post = spike_post();
    post.boundaries.push("red-tail".to_string());
    store
        .apply_actor_page(actor_page(8, vec![post], Vec::new()))
        .unwrap();

    assert_eq!(store.purge_boundary("bebop").unwrap(), 0);
    assert!(
        store
            .list_posts_by_boundary("bebop", None, 50, "1998-04-03T12:00:00.000Z")
            .unwrap()
            .posts
            .is_empty()
    );
    assert_eq!(
        store
            .list_posts_by_boundary("red-tail", None, 50, "1998-04-03T12:00:00.000Z")
            .unwrap()
            .posts
            .len(),
        1
    );
}

#[test]
fn loads_an_owner_only_hex_key_file() {
    let path = write_secret_file(
        "secret-key",
        b"0707070707070707070707070707070707070707070707070707070707070707\n",
        0o600,
    );
    assert_eq!(
        format!("{:?}", StorageKey::from_secret_file(&path).unwrap()),
        "StorageKey([REDACTED])"
    );
    fs::remove_file(path).unwrap();
}

#[test]
fn rejects_permissive_or_malformed_secret_files() {
    let permissive = write_secret_file(
        "permissive-secret-key",
        b"0707070707070707070707070707070707070707070707070707070707070707",
        0o644,
    );
    assert!(matches!(
        StorageKey::from_secret_file(&permissive),
        Err(super::StoreError::InsecureKeyFile)
    ));
    fs::remove_file(permissive).unwrap();

    let malformed = write_secret_file("malformed-secret-key", b"not-a-key", 0o600);
    assert!(matches!(
        StorageKey::from_secret_file(&malformed),
        Err(super::StoreError::InvalidKeyFile)
    ));
    fs::remove_file(malformed).unwrap();

    let oversized = write_secret_file(
        "oversized-secret-key",
        b"07070707070707070707070707070707070707070707070707070707070707070",
        0o600,
    );
    assert!(matches!(
        StorageKey::from_secret_file(&oversized),
        Err(super::StoreError::InvalidKeyFile)
    ));
    fs::remove_file(oversized).unwrap();
}

#[test]
fn rejects_symlinked_secret_files() {
    let target = write_secret_file(
        "secret-key-target",
        b"0707070707070707070707070707070707070707070707070707070707070707",
        0o600,
    );
    let link = temporary_path("secret-key-link");
    let _ = fs::remove_file(&link);
    symlink(&target, &link).unwrap();

    assert!(matches!(
        StorageKey::from_secret_file(&link),
        Err(super::StoreError::KeyFileAccess)
    ));
    fs::remove_file(link).unwrap();
    fs::remove_file(target).unwrap();
}

#[test]
fn rejects_secret_files_under_symlinked_directories() {
    let target_directory = temporary_path("secret-key-directory");
    let _ = fs::remove_dir_all(&target_directory);
    fs::create_dir(&target_directory).unwrap();
    let target = target_directory.join("key");
    fs::write(
        &target,
        b"0707070707070707070707070707070707070707070707070707070707070707",
    )
    .unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    let link = temporary_path("secret-key-directory-link");
    let _ = fs::remove_file(&link);
    symlink(&target_directory, &link).unwrap();

    assert!(matches!(
        StorageKey::from_secret_file(&link.join("key")),
        Err(super::StoreError::KeyFileAccess)
    ));
    fs::remove_file(link).unwrap();
    fs::remove_dir_all(target_directory).unwrap();
}

const LEGACY_SPACE_POST: &str = "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/see-you";
const LEGACY_ORPHANED_POST: &str = "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/gone";
const CURRENT_SPACE_POST: &str = "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/see-you";
const LABEL_AUTHORITY: &str = "did:web:stratos.example";
const LEGACY_LIKE: &str = "at://did:plc:edwardwong/app.bsky.feed.like/ein";
const LEGACY_ORPHAN_LIKE: &str = "at://did:plc:edwardwong/app.bsky.feed.like/corgi";
const CURRENT_LIKE: &str = "at://did:plc:fayevalentine/app.bsky.feed.like/swordfish";
const READ_AT: &str = "1998-04-03T12:00:00.000Z";

fn insert_space_post_row(store: &EncryptedStore, uri: &str, blob_refs_json: &str) {
    store
        .connection
        .execute(
            "INSERT INTO post (uri, author_did, cid, sort_at, indexed_at, retained_at, projection_bytes, record_json, blob_refs_json, row_version)
             VALUES (?1, 'did:plc:spikespiegel', 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                     '1998-04-03T00:00:00.000Z', '1998-04-03T00:00:01.000Z', '1998-05-03T00:00:00.000Z', 100,
                     x'7b7d', ?2, 1)",
            rusqlite::params![uri, blob_refs_json.as_bytes()],
        )
        .unwrap();
    store
        .connection
        .execute(
            "INSERT INTO post_boundary (uri, boundary, sort_at) VALUES (?1, 'bebop', '1998-04-03T00:00:00.000Z')",
            [uri],
        )
        .unwrap();
}

fn insert_like(store: &EncryptedStore, uri: &str, actor_did: &str, subject_uri: &str) {
    store
        .connection
        .execute(
            "INSERT INTO interaction (uri, actor_did, kind, subject_uri, boundary, indexed_at, retained_at, projection_bytes)
             VALUES (?1, ?2, 'like', ?3, 'bebop', '1998-04-03T00:00:01.000Z', '1998-05-03T00:00:00.000Z', 100)",
            rusqlite::params![uri, actor_did, subject_uri],
        )
        .unwrap();
}

/// Rows an older build wrote in the previous spelling, beside the current one.
fn store_holding_both_spellings() -> EncryptedStore {
    let store = EncryptedStore::open_memory(key(7)).unwrap();
    insert_space_post_row(&store, LEGACY_SPACE_POST, r#"[{"cid":"bafylegacy"}]"#);
    insert_like(&store, LEGACY_LIKE, "did:plc:edwardwong", LEGACY_SPACE_POST);
    insert_like(
        &store,
        LEGACY_ORPHAN_LIKE,
        "did:plc:edwardwong",
        LEGACY_ORPHANED_POST,
    );
    store
        .connection
        .execute(
            "INSERT INTO label_subject (authority_did, subject_key, subject_kind, author_did, label_sequence, state, attempts)
             VALUES (?1, ?2, 'record', 'did:plc:spikespiegel', 1, 'takedown', 0)",
            rusqlite::params![LABEL_AUTHORITY, LEGACY_SPACE_POST],
        )
        .unwrap();
    insert_space_post_row(&store, CURRENT_SPACE_POST, "[]");
    insert_like(
        &store,
        CURRENT_LIKE,
        "did:plc:fayevalentine",
        CURRENT_SPACE_POST,
    );
    store
}

fn post_count(store: &EncryptedStore, uri: &str) -> i64 {
    store
        .connection
        .query_row("SELECT COUNT(*) FROM post WHERE uri = ?1", [uri], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn a_feed_read_serves_the_current_post_beside_a_row_in_the_previous_spelling() {
    let store = store_holding_both_spellings();

    let uris: Vec<String> = store
        .list_posts_by_boundary("bebop", None, 50, READ_AT)
        .unwrap()
        .posts
        .into_iter()
        .map(|post| post.uri)
        .collect();

    assert_eq!(uris, [LEGACY_SPACE_POST, CURRENT_SPACE_POST]);
}

#[test]
fn a_like_is_counted_on_the_post_of_its_own_subject_spelling_only() {
    let store = store_holding_both_spellings();

    let summaries = store
        .interaction_summaries(
            "bebop",
            "did:plc:fayevalentine",
            &[CURRENT_SPACE_POST.to_owned(), LEGACY_SPACE_POST.to_owned()],
            READ_AT,
        )
        .unwrap();

    let current = &summaries[CURRENT_SPACE_POST];
    assert_eq!(current.like_count, 1);
    assert_eq!(current.viewer_like.as_deref(), Some(CURRENT_LIKE));
    let legacy = &summaries[LEGACY_SPACE_POST];
    assert_eq!(legacy.like_count, 1);
    assert_eq!(legacy.viewer_like, None);

    for (requested, other) in [
        (CURRENT_SPACE_POST, LEGACY_SPACE_POST),
        (LEGACY_SPACE_POST, CURRENT_SPACE_POST),
    ] {
        let alone = store
            .interaction_summaries(
                "bebop",
                "did:plc:fayevalentine",
                &[requested.to_owned()],
                READ_AT,
            )
            .unwrap();
        assert_eq!(
            alone.len(),
            1,
            "{other} must not be counted for {requested}"
        );
        assert_eq!(alone[requested].like_count, 1);
    }
}

#[test]
fn a_blob_lookup_by_the_current_uri_finds_the_current_post_only() {
    let store = store_holding_both_spellings();

    let current = store
        .blob_post(CURRENT_SPACE_POST, READ_AT)
        .unwrap()
        .unwrap();
    assert_eq!(current.uri, CURRENT_SPACE_POST);
    assert_eq!(current.blob_refs_json, b"[]");
    let legacy = store
        .blob_post(LEGACY_SPACE_POST, READ_AT)
        .unwrap()
        .unwrap();
    assert_eq!(legacy.blob_refs_json, br#"[{"cid":"bafylegacy"}]"#);
}

#[test]
fn a_legacy_takedown_does_not_suppress_the_current_post() {
    let store = store_holding_both_spellings();

    assert!(
        store
            .is_taken_down(LABEL_AUTHORITY, LEGACY_SPACE_POST)
            .unwrap()
    );
    assert!(
        !store
            .is_taken_down(LABEL_AUTHORITY, CURRENT_SPACE_POST)
            .unwrap()
    );
    assert_eq!(post_count(&store, CURRENT_SPACE_POST), 1);
}

#[test]
fn a_takedown_of_the_current_uri_leaves_the_row_in_the_previous_spelling() {
    let mut store = store_holding_both_spellings();

    store
        .apply_label_page(
            LABEL_AUTHORITY,
            &crate::moderation_label::LabelPage {
                cursor: 2,
                labels: vec![crate::moderation_label::ModerationLabel {
                    seq: 2,
                    subject: crate::moderation_label::LabelSubject::Record {
                        uri: CURRENT_SPACE_POST.to_owned(),
                        author_did: "did:plc:spikespiegel".to_owned(),
                    },
                    neg: false,
                }],
                skipped_subjects: 0,
            },
            "1998-04-03T00:00:02.000Z",
        )
        .unwrap();

    assert_eq!(post_count(&store, CURRENT_SPACE_POST), 0);
    assert_eq!(post_count(&store, LEGACY_SPACE_POST), 1);
    assert!(
        store
            .is_taken_down(LABEL_AUTHORITY, CURRENT_SPACE_POST)
            .unwrap()
    );
    assert!(
        store
            .is_taken_down(LABEL_AUTHORITY, LEGACY_SPACE_POST)
            .unwrap()
    );
    let remaining_likes: Vec<String> = store
        .connection
        .prepare("SELECT uri FROM interaction ORDER BY uri")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(remaining_likes, [LEGACY_ORPHAN_LIKE, LEGACY_LIKE]);
}

#[test]
fn retention_and_orphan_eviction_run_over_rows_in_the_previous_spelling() {
    let mut store = store_holding_both_spellings();
    let published_bytes: i64 = store
        .connection
        .query_row(
            "SELECT (SELECT SUM(projection_bytes) FROM post) + (SELECT SUM(projection_bytes) FROM interaction)",
            [],
            |row| row.get(0),
        )
        .unwrap();

    let compaction = store
        .compact_projection(
            "1998-04-01T00:00:00.000Z",
            "1998-06-01T00:00:00.000Z",
            (published_bytes - 1) as u64,
            10,
        )
        .unwrap();

    assert_eq!(compaction.deleted, 1);
    assert_eq!(post_count(&store, LEGACY_SPACE_POST), 1);
    assert_eq!(post_count(&store, CURRENT_SPACE_POST), 1);
    let orphan_likes: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM interaction WHERE uri = ?1",
            [LEGACY_ORPHAN_LIKE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(orphan_likes, 0);
    store.purge_expired("1998-06-01T00:00:00.000Z", 10).unwrap();
    let rows_left: i64 = store
        .connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM post) + (SELECT COUNT(*) FROM interaction)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows_left, 0);
}

#[test]
fn an_actor_page_that_fails_partway_through_its_transaction_stores_nothing() {
    let mut store = EncryptedStore::open_memory(key(7)).unwrap();
    store
        .apply_actor_page(actor_page(6, Vec::new(), Vec::new()))
        .unwrap();
    let posts = (0..200)
        .map(|index| {
            let mut post = spike_post();
            post.uri = format!("at://did:plc:spikespiegel/zone.stratos.feed.post/bebop{index:03}");
            post
        })
        .collect::<Vec<_>>();
    let last_uri = posts[199].uri.clone();
    // The last of the page's writes fails after the other 199 have been made.
    store
        .connection
        .execute(
            &format!(
                "CREATE TEMP TRIGGER refuse_last_post BEFORE INSERT ON post WHEN NEW.uri = '{last_uri}'
                 BEGIN SELECT RAISE(ABORT, 'the last post is refused'); END"
            ),
            [],
        )
        .unwrap();

    assert!(
        store
            .apply_actor_page(actor_page(7, posts, Vec::new()))
            .is_err()
    );

    let stored: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0))
        .unwrap();
    let cursor: i64 = store
        .connection
        .query_row(
            "SELECT sequence FROM actor_cursor WHERE did = 'did:plc:spikespiegel'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!((stored, cursor), (0, 6));
}

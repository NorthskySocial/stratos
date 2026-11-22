use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use tokio::{sync::watch, task::JoinHandle};
use tokio_tungstenite::tungstenite::Message;

use super::{ActorStreamConfig, run_actor_worker_with_telemetry};
use crate::{
    config::MAX_ACTOR_FRAME_BYTES,
    lifecycle::ControlLifecycle,
    readiness::FeedReadinessGate,
    service::ProjectionReader,
    store::{ActorEnrollment, EncryptedStore, StorageKey},
    telemetry::FeedTelemetry,
};

const AUTHORITY: &str = "did:web:stratos.example.test";
const BEBOP: &str = "did:web:stratos.example.test/bebop";
const FAYE: &str = "did:plc:faye";
const WAIT: Duration = Duration::from_secs(5);

fn enrolled_lifecycle() -> Arc<ControlLifecycle> {
    let lifecycle = ControlLifecycle::for_authority(
        ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        ),
        Arc::new(Mutex::new(FeedReadinessGate::default())),
        AUTHORITY,
    )
    .unwrap();
    lifecycle
        .reconcile_actor_enrollment(
            FAYE,
            "1998-04-03T00:00:00.000Z",
            Some(ActorEnrollment {
                did: FAYE.to_owned(),
                boundaries: vec![BEBOP.to_owned()],
                observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
            }),
        )
        .unwrap();
    Arc::new(lifecycle)
}

fn post_frame(text: &str) -> Vec<u8> {
    let mut frame = serde_cbor::to_vec(&serde_json::json!({"t": "#commit"})).unwrap();
    frame.extend(
        serde_cbor::to_vec(&serde_json::json!({
            "seq": 7,
            "did": FAYE,
            "time": "1998-04-03T00:00:00.000Z",
            "rev": "3jzfcijpj2z2a",
            "ops": [{
                "action": "create",
                "path": "zone.stratos.feed.post/julia",
                "cid": "bafyreia",
                "record": {
                    "$type": "zone.stratos.feed.post",
                    "text": text,
                    "createdAt": "1998-04-03T00:00:00.000Z",
                },
                "boundary": {"values": [{"value": BEBOP}]},
            }],
        }))
        .unwrap(),
    );
    frame
}

/// A one-post commit frame padded to exactly `length` bytes.
fn post_frame_of_length(length: usize) -> Vec<u8> {
    // Past 65,535 bytes a CBOR text header stops growing, so one step lands.
    let frame = post_frame(&"j".repeat(length - post_frame("").len() - 4));
    assert_eq!(frame.len(), length);
    frame
}

/// Sends every connection one binary frame, then holds it open until the client closes.
async fn serve_frame(frame: Vec<u8>) -> (SocketAddr, JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let frame = frame.clone();
            tokio::spawn(async move {
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                if socket.send(Message::binary(frame)).await.is_err() {
                    return;
                }
                while let Some(Ok(message)) = socket.next().await {
                    if message.is_close() {
                        break;
                    }
                }
            });
        }
    });
    (address, task)
}

struct WorkerRun {
    lifecycle: Arc<ControlLifecycle>,
    telemetry: Arc<FeedTelemetry>,
    failures: watch::Sender<u64>,
    shutdown: watch::Sender<bool>,
    worker: JoinHandle<()>,
    server: JoinHandle<()>,
}

impl WorkerRun {
    async fn start(frame: Vec<u8>) -> Self {
        let (address, server) = serve_frame(frame).await;
        let lifecycle = enrolled_lifecycle();
        let telemetry = Arc::new(FeedTelemetry::disabled());
        let (failures, _) = watch::channel(0_u64);
        let (shutdown, receiver) = watch::channel(false);
        let config = ActorStreamConfig {
            service_url: format!("http://{address}"),
            service_did: AUTHORITY.to_owned(),
            feedgen_did: "did:web:feedgen.example.test".to_owned(),
            signing_key: crate::service_auth::ServiceSigningKey::from_hex(&"11".repeat(32))
                .unwrap(),
            retention: Duration::from_secs(60),
            max_connections: 1,
        };
        let worker = tokio::spawn(run_actor_worker_with_telemetry(
            config,
            Arc::clone(&lifecycle),
            failures.clone(),
            FAYE.to_owned(),
            receiver,
            Arc::clone(&telemetry),
        ));
        Self {
            lifecycle,
            telemetry,
            failures,
            shutdown,
            worker,
            server,
        }
    }

    fn cursor(&self) -> Option<u64> {
        self.lifecycle
            .actor_sync_state(AUTHORITY, FAYE)
            .unwrap()
            .expect("Faye is enrolled")
            .cursor
    }

    async fn wait_until(&self, condition: impl Fn(&Self) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + WAIT;
        while tokio::time::Instant::now() < deadline {
            if condition(self) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        condition(self)
    }

    async fn stop(self) {
        let _ = self.shutdown.send(true);
        tokio::time::timeout(WAIT, self.worker)
            .await
            .unwrap()
            .unwrap();
        self.server.abort();
    }
}

#[tokio::test]
async fn a_frame_at_the_limit_crosses_the_websocket_and_applies() {
    let run = WorkerRun::start(post_frame_of_length(MAX_ACTOR_FRAME_BYTES)).await;

    assert!(run.wait_until(|run| run.cursor() == Some(7)).await);

    assert_eq!(run.telemetry.oversized_actor_frames(), 0);
    run.stop().await;
}

#[tokio::test]
async fn a_frame_one_byte_over_the_limit_is_refused_counted_and_leaves_the_cursor() {
    let run = WorkerRun::start(post_frame_of_length(MAX_ACTOR_FRAME_BYTES + 1)).await;

    assert!(
        run.wait_until(|run| run.telemetry.oversized_actor_frames() > 0)
            .await
    );

    assert_eq!(run.cursor(), None);
    assert!(*run.failures.borrow() > 0);
    run.stop().await;
}

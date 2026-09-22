use std::{
    future::Future,
    sync::{Arc, Mutex},
};

use stratos_feedgen_ng::{
    actor_stream::{ActorPool, ActorStreamConfig},
    auth::FeedRequestVerifier,
    authority::{AuthorityClient, HttpAuthorityClient},
    blob_cache::{BlobCache, BlobCacheSweeper, MAX_CACHE_BYTES},
    blob_service::BlobService,
    blob_upstream::HttpBlobUpstream,
    config::FeedgenConfig,
    credential_issuer::HttpSpaceCredentialIssuer,
    credential_manager::SpaceCredentialManager,
    identity::HttpIdentityKeyResolver,
    lifecycle::ControlLifecycle,
    membership_reconciler::MembershipReconciler,
    pds_space_scheduler::PdsSpaceScheduler,
    pds_space_sync::{PdsSpaceSynchronizer, PinnedSpacePageSource},
    readiness::FeedReadinessGate,
    retention::RetentionCompactor,
    runtime::open_projection_store,
    server,
    service::ProjectionReader,
    service_stream::{ServiceStream, ServiceStreamConfig},
    space_commit::SpaceCommitVerifier,
    space_membership::HttpSpaceMembershipClient,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = FeedgenConfig::from_env()?;
    let feeds = FeedgenConfig::load_feed_registry_from_env()?;
    let shutdown = shutdown_signal()?;
    let projection = ProjectionReader::new(open_projection_store(&config.storage)?);
    let port = std::env::var("FEEDGEN_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3000);
    let address = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;

    // Feeds remain unavailable until verified reconciliation completes.
    let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
    let lifecycle = Arc::new(ControlLifecycle::for_authority(
        projection,
        Arc::clone(&readiness),
        config.stratos_service_did.clone(),
    )?);
    let compactor = RetentionCompactor::start(Arc::clone(&lifecycle), config.retention.clone())?;
    let resolver = Arc::new(HttpIdentityKeyResolver::new(Some(&config.plc_url))?);
    let credential_manager = Arc::new(SpaceCredentialManager::new(Arc::new(
        HttpSpaceCredentialIssuer::new(
            &config.stratos_service_url,
            &config.stratos_public_url,
            config.stratos_service_did.clone(),
            config.service_did.clone(),
            config.signing_key.clone(),
        )?,
    )));
    let membership = Arc::new(MembershipReconciler::new(
        Arc::new(HttpSpaceMembershipClient::new(
            &config.stratos_service_url,
            &config.stratos_public_url,
        )?),
        Arc::clone(&credential_manager),
    ));
    let synchronizer = Arc::new(PdsSpaceSynchronizer::new(
        Arc::new(PinnedSpacePageSource),
        credential_manager,
        Arc::new(SpaceCommitVerifier::new(Box::new(Arc::clone(&resolver)))),
    ));
    let pds_scheduler = PdsSpaceScheduler::start(
        Arc::clone(&lifecycle),
        membership,
        synchronizer,
        feeds.list().map(|feed| feed.boundary.clone()),
        config.retention.clone(),
    );
    let blob_cache = Arc::new(Mutex::new(BlobCache::new(
        MAX_CACHE_BYTES,
        std::time::Duration::from_secs(300),
    )?));
    let blob_service = Arc::new(BlobService::new(
        Arc::clone(&blob_cache),
        Arc::new(HttpBlobUpstream::new(
            &config.stratos_service_url,
            config.stratos_service_did.clone(),
            config.service_did.clone(),
            config.signing_key.clone(),
        )?),
        2,
    )?);
    let blob_sweeper = BlobCacheSweeper::start(blob_cache);
    let authority: Arc<dyn AuthorityClient> = Arc::new(HttpAuthorityClient::new(
        &config.stratos_service_url,
        config.stratos_service_did.clone(),
        config.service_did.clone(),
        config.signing_key.clone(),
    )?);
    let actors = ActorPool::start(
        ActorStreamConfig {
            service_url: config.stratos_service_url.clone(),
            service_did: config.stratos_service_did.clone(),
            feedgen_did: config.service_did.clone(),
            signing_key: config.signing_key.clone(),
            retention: config.retention.max_age,
            max_connections: config.actor_max_connections,
        },
        Arc::clone(&lifecycle),
    )?;
    let stream = ServiceStream::start(
        ServiceStreamConfig {
            service_url: config.stratos_service_url.clone(),
            service_did: config.stratos_service_did.clone(),
            feedgen_did: config.service_did.clone(),
            signing_key: config.signing_key.clone(),
            reconciliation: Default::default(),
        },
        Arc::clone(&lifecycle),
        authority,
        actors,
    )?;
    let verifier = FeedRequestVerifier::new(
        config.service_did.clone(),
        [
            "zone.stratos.feedgen.getFeed".to_owned(),
            "zone.stratos.feedgen.getBlob".to_owned(),
        ],
        resolver as Arc<dyn stratos_feedgen_ng::auth::IdentityKeyResolver>,
    );
    let result = axum::serve(
        listener,
        server::router_with_feed_with_pds_space_sync(
            config,
            feeds,
            readiness,
            lifecycle,
            verifier,
            pds_scheduler.status(),
            blob_service,
        ),
    )
    .with_graceful_shutdown(shutdown)
    .await;
    pds_scheduler.stop().await;
    blob_sweeper.stop().await;
    compactor.stop().await;
    stream.stop().await;
    result?;
    Ok(())
}

#[cfg(unix)]
fn shutdown_signal() -> std::io::Result<impl Future<Output = ()>> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    Ok(async move {
        wait_for_shutdown(
            async move {
                let _ = interrupt.recv().await;
            },
            async move {
                let _ = terminate.recv().await;
            },
        )
        .await;
    })
}

#[cfg(not(unix))]
fn shutdown_signal() -> std::io::Result<impl Future<Output = ()>> {
    Ok(async {
        // Platforms without synchronous signal registration fail closed if Ctrl-C setup fails.
        match tokio::signal::ctrl_c().await {
            Ok(()) | Err(_) => {}
        }
    })
}

async fn wait_for_shutdown(
    interrupt: impl Future<Output = ()>,
    terminate: impl Future<Output = ()>,
) {
    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
}

#[cfg(test)]
mod tests {
    use tokio::{sync::oneshot, time::timeout};

    use super::wait_for_shutdown;

    #[tokio::test]
    async fn shutdown_wait_completes_for_interrupt() {
        let (interrupt_sent, interrupt_received) = oneshot::channel();
        let completed = tokio::spawn(wait_for_shutdown(
            async move {
                let _ = interrupt_received.await;
            },
            std::future::pending(),
        ));
        interrupt_sent.send(()).unwrap();
        timeout(std::time::Duration::from_millis(100), completed)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn shutdown_wait_completes_for_termination() {
        let (termination_sent, termination_received) = oneshot::channel();
        let completed = tokio::spawn(wait_for_shutdown(std::future::pending(), async move {
            let _ = termination_received.await;
        }));
        termination_sent.send(()).unwrap();
        timeout(std::time::Duration::from_millis(100), completed)
            .await
            .unwrap()
            .unwrap();
    }
}

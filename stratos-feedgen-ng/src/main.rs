use std::sync::{Arc, Mutex};

use stratos_feedgen_ng::{
    auth::FeedRequestVerifier, config::FeedgenConfig, identity::HttpIdentityKeyResolver,
    lifecycle::ControlLifecycle, readiness::FeedReadinessGate, runtime::open_projection_store,
    server, service::ProjectionReader,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = FeedgenConfig::from_env()?;
    let feeds = FeedgenConfig::load_feed_registry_from_env()?;
    let projection = ProjectionReader::new(open_projection_store(&config.storage)?);
    let port = std::env::var("FEEDGEN_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3000);
    let address = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;

    // Feeds remain unavailable until verified reconciliation completes.
    let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
    let lifecycle = Arc::new(ControlLifecycle::new(projection, Arc::clone(&readiness)));
    let resolver = Arc::new(HttpIdentityKeyResolver::new(Some(&config.plc_url))?);
    let verifier = FeedRequestVerifier::new(
        config.service_did.clone(),
        ["zone.stratos.feedgen.getFeed".to_owned()],
        resolver as Arc<dyn stratos_feedgen_ng::auth::IdentityKeyResolver>,
    );
    axum::serve(
        listener,
        server::router_with_feed(config, feeds, readiness, lifecycle, verifier),
    )
    .await?;
    Ok(())
}

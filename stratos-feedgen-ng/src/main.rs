use std::sync::{Arc, Mutex};

use stratos_feedgen_ng::{
    config::FeedgenConfig, readiness::FeedReadinessGate, runtime::open_projection_store, server,
    service::ProjectionReader,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = FeedgenConfig::from_env()?;
    let _feeds = FeedgenConfig::load_feed_registry_from_env()?;
    let _projection = ProjectionReader::new(open_projection_store(&config.storage)?);
    let port = std::env::var("FEEDGEN_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3000);
    let address = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;

    // Feeds remain unavailable until verified reconciliation completes.
    let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
    axum::serve(listener, server::router(config, readiness)).await?;
    Ok(())
}

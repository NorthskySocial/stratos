use std::sync::{Arc, Mutex};

use stratos_feedgen_ng::{config::FeedgenConfig, readiness::FeedReadinessGate, server};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = FeedgenConfig::from_env()?;
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

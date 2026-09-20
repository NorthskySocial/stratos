use std::sync::{Arc, Mutex};

use stratos_feedgen_rust::{config::FeedgenConfig, readiness::FeedReadinessGate, server};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = FeedgenConfig::from_env()?;
    let port = std::env::var("FEEDGEN_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3000);
    let address = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;

    // This initial surface is deliberately unavailable until stream and
    // reconciliation implementations are ported and proven by the corpus.
    let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
    axum::serve(listener, server::router(config, readiness)).await?;
    Ok(())
}

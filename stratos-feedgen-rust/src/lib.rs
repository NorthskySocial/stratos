//! Rust Feedgen foundations.
//!
//! This crate deliberately starts fail-closed: it exposes only the discovery
//! and readiness surface. It does not accept feed traffic, persist posts, or
//! subscribe to Stratos until the shared conformance corpus and storage policy
//! are implemented.

pub mod config;
pub mod readiness;
pub mod server;

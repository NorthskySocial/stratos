//! Fail-closed Feedgen implementation.
//!
//! Exposes discovery and readiness only; it does not serve feeds or persist data.

pub mod admission;
pub mod auth;
pub mod authority;
pub mod authorization;
pub mod config;
pub mod conformance;
pub mod cursor;
pub mod feed_service;
pub mod feeds;
pub mod identifier;
pub mod identity;
pub mod lifecycle;
pub mod readiness;
pub mod reconciliation;
pub mod runtime;
pub mod server;
pub mod service;
pub mod service_auth;
pub mod store;

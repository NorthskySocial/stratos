//! Fail-closed Feedgen implementation.
//!
//! Maintains an encrypted bounded projection and serves authenticated,
//! boundary-scoped feeds after authority reconciliation.

pub mod actor_event;
pub mod actor_stream;
pub mod admission;
pub mod auth;
pub mod authority;
pub mod authorization;
pub mod blob_cache;
pub mod blob_service;
pub mod blob_upstream;
pub mod config;
pub mod conformance;
pub mod credential_issuer;
pub mod credential_manager;
pub mod cursor;
pub mod feed_service;
pub mod feeds;
pub mod identifier;
pub mod identity;
mod identity_key;
pub mod lifecycle;
pub mod membership_reconciler;
pub mod pds_space_scheduler;
pub mod pds_space_sync;
pub mod readiness;
pub mod reconciliation;
pub mod retention;
pub mod runtime;
pub mod server;
pub mod service;
pub mod service_auth;
pub mod service_event;
pub mod service_stream;
pub mod space_commit;
pub mod space_credential;
pub mod space_host;
pub mod space_membership;
pub mod space_sync;
pub mod store;
pub mod telemetry;
mod websocket_client;
pub mod writer_lock;

//! Bounded, aggregate-only operational telemetry.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use opentelemetry::{
    KeyValue,
    metrics::{Counter, Histogram, MeterProvider, ObservableGauge, UpDownCounter},
};
use opentelemetry_otlp::{MetricExporter, WithExportConfig};
use opentelemetry_sdk::{
    Resource,
    metrics::{PeriodicReader, SdkMeterProvider},
};

use crate::config::MetricsExportConfig;

const METER_SCOPE: &str = "stratos.feedgen.ng";
const EXPORT_INTERVAL: Duration = Duration::from_secs(60);
const EXPORT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FeedReadStage {
    VerifyAuthorization,
    ViewerAuthorization,
    ProjectionSerialization,
}

impl FeedReadStage {
    const fn label(self) -> &'static str {
        match self {
            Self::VerifyAuthorization => "verify_authorization",
            Self::ViewerAuthorization => "viewer_authorization",
            Self::ProjectionSerialization => "projection_serialization",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FeedReadStageOutcome {
    Success,
    Failure,
    Timeout,
}

impl FeedReadStageOutcome {
    const fn label(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Timeout => "timeout",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FeedRequestOutcome {
    Ok,
    ExpectedError,
    Error,
}

impl FeedRequestOutcome {
    const fn label(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::ExpectedError => "expected_error",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReconciliationOutcome {
    Ok,
    Partial,
    Failed,
}

impl ReconciliationOutcome {
    const fn label(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Partial => "partial",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpaceSyncOutcome {
    Ok,
    Partial,
    Failed,
}

impl SpaceSyncOutcome {
    const fn label(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Partial => "partial",
            Self::Failed => "failed",
        }
    }
}

#[derive(Default)]
struct RuntimeState {
    ready: AtomicBool,
    service_connected: AtomicBool,
    actor_active: AtomicU64,
    actor_waiting: AtomicU64,
    actor_capacity: AtomicU64,
    last_space_sync_success: AtomicU64,
}

#[derive(Clone)]
pub struct FeedTelemetry {
    state: Arc<RuntimeState>,
    stage_duration: Option<Histogram<f64>>,
    http_duration: Option<Histogram<f64>>,
    active_requests: Option<UpDownCounter<i64>>,
    feed_requests: Option<Counter<u64>>,
    posts_returned: Option<Histogram<u64>>,
    reconnects: Option<Counter<u64>>,
    index_operations: Option<Counter<u64>>,
    cache_requests: Option<Counter<u64>>,
    reconciliation_duration: Option<Histogram<f64>>,
    reconciliation_outcomes: Option<Counter<u64>>,
    space_sync_duration: Option<Histogram<f64>>,
    space_sync_outcomes: Option<Counter<u64>>,
    // These keep observable callbacks alive for the provider lifetime.
    _heartbeat: Option<ObservableGauge<u64>>,
    _readiness: Option<ObservableGauge<u64>>,
    _connected: Option<ObservableGauge<u64>>,
    _actor_pool: Option<ObservableGauge<u64>>,
    _last_space_sync_success: Option<ObservableGauge<u64>>,
}

impl FeedTelemetry {
    pub fn disabled() -> Self {
        Self {
            state: Arc::new(RuntimeState::default()),
            stage_duration: None,
            http_duration: None,
            active_requests: None,
            feed_requests: None,
            posts_returned: None,
            reconnects: None,
            index_operations: None,
            cache_requests: None,
            reconciliation_duration: None,
            reconciliation_outcomes: None,
            space_sync_duration: None,
            space_sync_outcomes: None,
            _heartbeat: None,
            _readiness: None,
            _connected: None,
            _actor_pool: None,
            _last_space_sync_success: None,
        }
    }

    fn enabled(provider: &SdkMeterProvider) -> Self {
        let meter = provider.meter(METER_SCOPE);
        let state = Arc::new(RuntimeState::default());
        let heartbeat_state = Arc::clone(&state);
        let ready_state = Arc::clone(&state);
        let connected_state = Arc::clone(&state);
        let pool_state = Arc::clone(&state);
        let success_state = Arc::clone(&state);
        Self {
            state,
            stage_duration: Some(
                meter
                    .f64_histogram("stratos.feedgen.read.stage.duration")
                    .with_unit("s")
                    .with_description("Aggregate feed-read stage duration")
                    .build(),
            ),
            http_duration: Some(
                meter
                    .f64_histogram("http.server.request.duration")
                    .with_unit("s")
                    .with_description("Duration of HTTP server requests.")
                    .build(),
            ),
            active_requests: Some(
                meter
                    .i64_up_down_counter("http.server.active_requests")
                    .with_description("HTTP requests currently being served.")
                    .build(),
            ),
            feed_requests: Some(
                meter
                    .u64_counter("stratos.feedgen.feed.requests")
                    .with_description("Feed requests by bounded outcome.")
                    .build(),
            ),
            posts_returned: Some(
                meter
                    .u64_histogram("stratos.feedgen.feed.posts_returned")
                    .with_unit("{posts}")
                    .with_description("Posts returned from a feed request.")
                    .build(),
            ),
            reconnects: Some(
                meter
                    .u64_counter("stratos.feedgen.subscription.reconnects")
                    .with_description("Scheduled subscription reconnects.")
                    .build(),
            ),
            index_operations: Some(
                meter
                    .u64_counter("stratos.feedgen.index.operations")
                    .with_description("Local feed index operations.")
                    .build(),
            ),
            cache_requests: Some(
                meter
                    .u64_counter("stratos.feedgen.cache.requests")
                    .with_description("Viewer-boundary cache requests.")
                    .build(),
            ),
            reconciliation_duration: Some(
                meter
                    .f64_histogram("stratos.feedgen.reconciliation.duration")
                    .with_unit("s")
                    .with_description("Enrollment reconciliation duration.")
                    .build(),
            ),
            reconciliation_outcomes: Some(
                meter
                    .u64_counter("stratos.feedgen.reconciliation.outcomes")
                    .with_description("Enrollment reconciliation outcomes.")
                    .build(),
            ),
            space_sync_duration: Some(
                meter
                    .f64_histogram("stratos.feedgen.space_sync.duration")
                    .with_unit("s")
                    .with_description("Space-sync pass duration.")
                    .build(),
            ),
            space_sync_outcomes: Some(
                meter
                    .u64_counter("stratos.feedgen.space_sync.outcomes")
                    .with_description("Space-sync pass and member outcomes.")
                    .build(),
            ),
            _heartbeat: Some(
                meter
                    .u64_observable_gauge("stratos.telemetry.heartbeat")
                    .with_unit("s")
                    .with_description("Unix timestamp of the latest telemetry observation.")
                    .with_callback(move |observer| {
                        let _ = &heartbeat_state;
                        observer.observe(unix_seconds(), &[]);
                    })
                    .build(),
            ),
            _readiness: Some(
                meter
                    .u64_observable_gauge("stratos.feedgen.ready")
                    .with_description("Whether feedgen is ready to serve an authoritative feed.")
                    .with_callback(move |observer| {
                        observer.observe(u64::from(ready_state.ready.load(Ordering::Relaxed)), &[]);
                    })
                    .build(),
            ),
            _connected: Some(
                meter
                    .u64_observable_gauge("stratos.feedgen.subscription.connected")
                    .with_description("Whether an authoritative subscription is connected.")
                    .with_callback(move |observer| {
                        observer.observe(
                            u64::from(connected_state.service_connected.load(Ordering::Relaxed)),
                            &[KeyValue::new("stream.kind", "service")],
                        );
                    })
                    .build(),
            ),
            _actor_pool: Some(
                meter
                    .u64_observable_gauge("stratos.feedgen.actor_pool")
                    .with_description("Actor-pool utilization.")
                    .with_callback(move |observer| {
                        observer.observe(
                            pool_state.actor_active.load(Ordering::Relaxed),
                            &[KeyValue::new("state", "active")],
                        );
                        observer.observe(
                            pool_state.actor_waiting.load(Ordering::Relaxed),
                            &[KeyValue::new("state", "waiting")],
                        );
                        observer.observe(
                            pool_state.actor_capacity.load(Ordering::Relaxed),
                            &[KeyValue::new("state", "capacity")],
                        );
                    })
                    .build(),
            ),
            _last_space_sync_success: Some(
                meter
                    .u64_observable_gauge("stratos.feedgen.space_sync.last_success")
                    .with_unit("s")
                    .with_description("Unix timestamp of the last successful space-sync pass.")
                    .with_callback(move |observer| {
                        let value = success_state
                            .last_space_sync_success
                            .load(Ordering::Relaxed);
                        if value != 0 {
                            observer.observe(value, &[]);
                        }
                    })
                    .build(),
            ),
        }
    }

    pub fn is_export_enabled(&self) -> bool {
        self.stage_duration.is_some()
    }
    pub fn set_ready(&self, ready: bool) {
        self.state.ready.store(ready, Ordering::Relaxed);
    }
    pub fn set_service_connected(&self, connected: bool) {
        self.state
            .service_connected
            .store(connected, Ordering::Relaxed);
    }
    pub fn set_actor_pool(&self, active: usize, waiting: usize, capacity: u16) {
        self.state
            .actor_active
            .store(active as u64, Ordering::Relaxed);
        self.state
            .actor_waiting
            .store(waiting as u64, Ordering::Relaxed);
        self.state
            .actor_capacity
            .store(u64::from(capacity), Ordering::Relaxed);
    }
    pub fn record_reconnect(&self, kind: &'static str) {
        if let Some(metric) = &self.reconnects {
            metric.add(1, &[KeyValue::new("stream.kind", kind)]);
        }
    }
    pub fn record_cache(&self, outcome: &'static str) {
        if let Some(metric) = &self.cache_requests {
            metric.add(1, &[KeyValue::new("outcome", outcome)]);
        }
    }
    pub fn record_index_operations(&self, upserts: usize, deletes: usize, outcome: &'static str) {
        let Some(metric) = &self.index_operations else {
            return;
        };
        if upserts != 0 {
            metric.add(
                upserts as u64,
                &[
                    KeyValue::new("operation", "upsert"),
                    KeyValue::new("outcome", outcome),
                ],
            );
        }
        if deletes != 0 {
            metric.add(
                deletes as u64,
                &[
                    KeyValue::new("operation", "delete"),
                    KeyValue::new("outcome", outcome),
                ],
            );
        }
    }
    pub fn record_reconciliation(&self, outcome: ReconciliationOutcome, elapsed: Duration) {
        let attributes = [KeyValue::new("outcome", outcome.label())];
        if let Some(metric) = &self.reconciliation_duration {
            metric.record(elapsed.as_secs_f64(), &attributes);
        }
        if let Some(metric) = &self.reconciliation_outcomes {
            metric.add(1, &attributes);
        }
    }
    pub fn record_space_sync(
        &self,
        outcome: SpaceSyncOutcome,
        elapsed: Duration,
        succeeded: usize,
        failed: usize,
        deferred: usize,
        rejected: usize,
    ) {
        if let Some(metric) = &self.space_sync_duration {
            metric.record(
                elapsed.as_secs_f64(),
                &[KeyValue::new("outcome", outcome.label())],
            );
        }
        if let Some(metric) = &self.space_sync_outcomes {
            metric.add(1, &[KeyValue::new("outcome", "pass")]);
            if succeeded != 0 {
                metric.add(succeeded as u64, &[KeyValue::new("outcome", "member_ok")]);
            }
            if failed != 0 {
                metric.add(failed as u64, &[KeyValue::new("outcome", "member_error")]);
            }
            if deferred != 0 {
                metric.add(
                    deferred as u64,
                    &[KeyValue::new("outcome", "member_deferred")],
                );
            }
            if rejected != 0 {
                metric.add(
                    rejected as u64,
                    &[KeyValue::new("outcome", "member_rejected")],
                );
            }
        }
        if outcome == SpaceSyncOutcome::Ok {
            self.state
                .last_space_sync_success
                .store(unix_seconds(), Ordering::Relaxed);
        }
    }
    pub fn start(&self, stage: FeedReadStage) -> FeedReadStageTimer<'_> {
        FeedReadStageTimer {
            telemetry: self,
            stage,
            started_at: Instant::now(),
        }
    }
    pub fn begin_http_request(&self) -> HttpRequestTimer<'_> {
        if let Some(metric) = &self.active_requests {
            metric.add(1, &[]);
        }
        HttpRequestTimer {
            telemetry: self,
            started_at: Instant::now(),
            completed: false,
        }
    }
    pub fn record_feed_request(&self, outcome: FeedRequestOutcome, posts_returned: Option<usize>) {
        if let Some(metric) = &self.feed_requests {
            metric.add(1, &[KeyValue::new("outcome", outcome.label())]);
        }
        if let (Some(metric), Some(posts)) = (&self.posts_returned, posts_returned) {
            metric.record(posts as u64, &[]);
        }
    }
    fn record_stage(&self, stage: FeedReadStage, outcome: FeedReadStageOutcome, elapsed: Duration) {
        if let Some(metric) = &self.stage_duration {
            metric.record(
                elapsed.as_secs_f64(),
                &[
                    KeyValue::new("stage", stage.label()),
                    KeyValue::new("outcome", outcome.label()),
                ],
            );
        }
    }
    fn finish_http(
        &self,
        method: &'static str,
        route: &'static str,
        status: u16,
        elapsed: Duration,
    ) {
        if let Some(metric) = &self.active_requests {
            metric.add(-1, &[]);
        }
        if let Some(metric) = &self.http_duration {
            metric.record(
                elapsed.as_secs_f64(),
                &[
                    KeyValue::new("http.request.method", method),
                    KeyValue::new("http.route", route),
                    KeyValue::new("http.response.status_code", i64::from(status)),
                ],
            );
        }
    }
    fn abort_http(&self) {
        if let Some(metric) = &self.active_requests {
            metric.add(-1, &[]);
        }
    }
}

pub struct FeedReadStageTimer<'a> {
    telemetry: &'a FeedTelemetry,
    stage: FeedReadStage,
    started_at: Instant,
}
impl FeedReadStageTimer<'_> {
    pub fn finish(self, outcome: FeedReadStageOutcome) {
        self.telemetry
            .record_stage(self.stage, outcome, self.started_at.elapsed());
    }
}

pub struct HttpRequestTimer<'a> {
    telemetry: &'a FeedTelemetry,
    started_at: Instant,
    completed: bool,
}
impl HttpRequestTimer<'_> {
    pub fn complete(mut self, method: &'static str, route: &'static str, status: u16) {
        self.telemetry
            .finish_http(method, route, status, self.started_at.elapsed());
        self.completed = true;
    }
}
impl Drop for HttpRequestTimer<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.telemetry.abort_http();
        }
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

pub struct MetricsRuntime {
    telemetry: Arc<FeedTelemetry>,
    provider: Option<SdkMeterProvider>,
}
impl MetricsRuntime {
    pub fn initialize(
        config: &MetricsExportConfig,
    ) -> Result<Self, opentelemetry_otlp::ExporterBuildError> {
        let Some(endpoint) = &config.otlp_http_endpoint else {
            return Ok(Self {
                telemetry: Arc::new(FeedTelemetry::disabled()),
                provider: None,
            });
        };
        let exporter = MetricExporter::builder()
            .with_http()
            .with_endpoint(endpoint)
            .with_timeout(EXPORT_TIMEOUT)
            .build()?;
        let reader = PeriodicReader::builder(exporter)
            .with_interval(EXPORT_INTERVAL)
            .build();
        let provider = SdkMeterProvider::builder()
            .with_resource(Resource::builder().build())
            .with_reader(reader)
            .build();
        Ok(Self {
            telemetry: Arc::new(FeedTelemetry::enabled(&provider)),
            provider: Some(provider),
        })
    }
    pub fn telemetry(&self) -> Arc<FeedTelemetry> {
        Arc::clone(&self.telemetry)
    }
    pub fn shutdown(self) {
        if let Some(provider) = self.provider {
            let _ = provider.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
    #[test]
    fn disabled_export_keeps_request_path_without_instruments() {
        let telemetry = FeedTelemetry::disabled();
        telemetry
            .begin_http_request()
            .complete("GET", "/health", 200);
        assert!(!telemetry.is_export_enabled());
    }
    #[test]
    fn records_only_static_operational_dimensions() {
        let exporter = InMemoryMetricExporter::default();
        let provider = SdkMeterProvider::builder()
            .with_reader(PeriodicReader::builder(exporter.clone()).build())
            .build();
        let telemetry = FeedTelemetry::enabled(&provider);
        telemetry.set_ready(true);
        telemetry.set_service_connected(true);
        telemetry.set_actor_pool(2, 1, 8);
        telemetry
            .begin_http_request()
            .complete("GET", "/xrpc/zone.stratos.feedgen.getFeed", 200);
        telemetry.record_feed_request(FeedRequestOutcome::Ok, Some(3));
        telemetry.record_cache("hit");
        telemetry.record_reconnect("service");
        telemetry.record_index_operations(2, 1, "ok");
        telemetry.record_reconciliation(ReconciliationOutcome::Ok, Duration::from_millis(1));
        telemetry.record_space_sync(SpaceSyncOutcome::Ok, Duration::from_millis(1), 1, 0, 0, 0);
        telemetry
            .start(FeedReadStage::VerifyAuthorization)
            .finish(FeedReadStageOutcome::Success);
        provider.force_flush().unwrap();
        let metrics = format!("{:?}", exporter.get_finished_metrics().unwrap());
        for name in [
            "stratos.telemetry.heartbeat",
            "stratos.feedgen.ready",
            "stratos.feedgen.subscription.connected",
            "stratos.feedgen.actor_pool",
            "http.server.request.duration",
            "http.server.active_requests",
            "stratos.feedgen.feed.requests",
            "stratos.feedgen.feed.posts_returned",
            "stratos.feedgen.cache.requests",
            "stratos.feedgen.reconciliation.duration",
            "stratos.feedgen.space_sync.duration",
        ] {
            assert!(metrics.contains(name), "missing metric {name}");
        }
        for label in [
            "/xrpc/zone.stratos.feedgen.getFeed",
            "service",
            "active",
            "waiting",
            "capacity",
            "verify_authorization",
        ] {
            assert!(metrics.contains(label), "missing fixed label {label}");
        }
        assert!(!metrics.contains("did:plc:"));
        provider.shutdown().unwrap();
    }
}

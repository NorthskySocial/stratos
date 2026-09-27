//! Bounded, aggregate-only feed request telemetry.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use opentelemetry::{
    KeyValue,
    metrics::{Histogram, MeterProvider},
};
use opentelemetry_otlp::{MetricExporter, WithExportConfig};
use opentelemetry_sdk::{
    Resource,
    metrics::{PeriodicReader, SdkMeterProvider},
};

use crate::config::MetricsExportConfig;

const METER_SCOPE: &str = "stratos.feedgen.ng";
const STAGE_DURATION_METRIC: &str = "stratos.feedgen.read.stage.duration";
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

#[derive(Clone)]
pub struct FeedTelemetry {
    stage_duration: Option<Histogram<f64>>,
}

impl FeedTelemetry {
    pub fn disabled() -> Self {
        Self {
            stage_duration: None,
        }
    }

    fn enabled(provider: &SdkMeterProvider) -> Self {
        let meter = provider.meter(METER_SCOPE);
        Self {
            stage_duration: Some(
                meter
                    .f64_histogram(STAGE_DURATION_METRIC)
                    .with_unit("s")
                    .with_description("Aggregate feed-read stage duration")
                    .build(),
            ),
        }
    }

    pub fn is_export_enabled(&self) -> bool {
        self.stage_duration.is_some()
    }

    pub fn start(&self, stage: FeedReadStage) -> FeedReadStageTimer<'_> {
        FeedReadStageTimer {
            telemetry: self,
            stage,
            started_at: Instant::now(),
        }
    }

    fn record(&self, stage: FeedReadStage, outcome: FeedReadStageOutcome, elapsed: Duration) {
        let Some(stage_duration) = &self.stage_duration else {
            return;
        };
        stage_duration.record(
            elapsed.as_secs_f64(),
            &[
                KeyValue::new("stage", stage.label()),
                KeyValue::new("outcome", outcome.label()),
            ],
        );
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
            .record(self.stage, outcome, self.started_at.elapsed());
    }
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
        let telemetry = Arc::new(FeedTelemetry::enabled(&provider));
        Ok(Self {
            telemetry,
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
    use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};

    use super::{FeedReadStage, FeedReadStageOutcome, FeedTelemetry, MetricsRuntime};
    use crate::config::MetricsExportConfig;

    #[test]
    fn disabled_export_keeps_the_request_path_without_a_metric_instrument() {
        let runtime = MetricsRuntime::initialize(&MetricsExportConfig {
            otlp_http_endpoint: None,
        })
        .unwrap();
        assert!(!runtime.telemetry().is_export_enabled());
        runtime
            .telemetry()
            .start(FeedReadStage::VerifyAuthorization)
            .finish(FeedReadStageOutcome::Success);
        runtime.shutdown();
    }

    #[test]
    fn stage_and_outcome_labels_are_static_and_bounded() {
        assert_eq!(
            FeedReadStage::VerifyAuthorization.label(),
            "verify_authorization"
        );
        assert_eq!(
            FeedReadStage::ViewerAuthorization.label(),
            "viewer_authorization"
        );
        assert_eq!(
            FeedReadStage::ProjectionSerialization.label(),
            "projection_serialization"
        );
        assert_eq!(FeedReadStageOutcome::Success.label(), "success");
        assert_eq!(FeedReadStageOutcome::Failure.label(), "failure");
        assert_eq!(FeedReadStageOutcome::Timeout.label(), "timeout");
        assert!(!FeedTelemetry::disabled().is_export_enabled());
    }

    #[test]
    fn records_only_the_fixed_stage_and_outcome_dimensions() {
        let exporter = InMemoryMetricExporter::default();
        let provider = SdkMeterProvider::builder()
            .with_reader(PeriodicReader::builder(exporter.clone()).build())
            .build();
        let telemetry = FeedTelemetry::enabled(&provider);
        for (stage, outcome) in [
            (
                FeedReadStage::VerifyAuthorization,
                FeedReadStageOutcome::Success,
            ),
            (
                FeedReadStage::ViewerAuthorization,
                FeedReadStageOutcome::Failure,
            ),
            (
                FeedReadStage::ProjectionSerialization,
                FeedReadStageOutcome::Timeout,
            ),
        ] {
            telemetry.start(stage).finish(outcome);
        }
        provider.force_flush().unwrap();
        let metrics = format!("{:?}", exporter.get_finished_metrics().unwrap());
        for label in [
            "verify_authorization",
            "viewer_authorization",
            "projection_serialization",
            "success",
            "failure",
            "timeout",
        ] {
            assert!(metrics.contains(label), "missing fixed label {label}");
        }
        assert!(!metrics.contains("did:plc:"));
        provider.shutdown().unwrap();
    }
}

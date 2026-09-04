# Telemetry

Use OpenTelemetry for service traces and Prometheus-format metrics for feed generator operations. Keep telemetry data free of record content, tokens, and other private values.

## OpenTelemetry traces

The deployment infrastructure mounts Node OpenTelemetry auto-instrumentation and exports traces by OTLP. It sets `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_EXPORTER=otlp`, and the OTLP endpoint and protocol for the application container.

The current infrastructure disables OpenTelemetry metric and log exporters. Use the Prometheus endpoint for feed generator metrics and structured application logs for event details.

## Feed generator metrics

When metrics are enabled, the feed generator exposes Prometheus text at `/metrics`. Set `FEEDGEN_METRICS_TOKEN` to require a bearer token. If the token is omitted, restrict the endpoint at the network layer.

Monitor these signals:

| Signal                                                                        | Meaning                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------ |
| `feedgen_requests_total`                                                      | Requests by endpoint and HTTP status.      |
| `feedgen_request_duration_seconds`                                            | Request latency by endpoint.               |
| `feedgen_subscriptions_open`                                                  | Open service and actor subscriptions.      |
| `feedgen_subscription_reconnects_total`                                       | Scheduled reconnects by subscription type. |
| `feedgen_index_posts_total`                                                   | Posts written to the local projection.     |
| `feedgen_boundary_cache_hits_total` and `feedgen_boundary_cache_misses_total` | Viewer membership cache behavior.          |

Alert on repeated subscription reconnects, a persistent zero service subscription, authorization reconciliation failures, and request failures on protected feed endpoints.

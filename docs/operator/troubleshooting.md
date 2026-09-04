# Troubleshooting

## Feed requests fail after startup

Check the feed generator health response. Confirm that the service stream is connected and that startup reconciliation completed. Then confirm that the request uses a PDS-issued service-auth token for the feed generator DID and lexicon.

## A member cannot read a post

Check current enrollment and the record boundaries. A valid old attestation does not grant access after a boundary change. Confirm that the feed generator projection processed the membership change and purged removed access.

## The feed is empty

Confirm that the requested feed boundary is configured. Check that the actor belongs to that boundary, the actor subscription is active, and the projection cursor advances after a record write.

## Metrics endpoint returns 401

Set the `Authorization` header to `Bearer <FEEDGEN_METRICS_TOKEN>`. If no token is configured, protect the endpoint with network policy instead.

## Trace data is missing

Confirm that the deployed workload has the OpenTelemetry auto-instrumentation mount and an OTLP endpoint. Check `OTEL_RESOURCE_ATTRIBUTES` and the trace exporter configuration. The feed generator Prometheus endpoint does not replace distributed traces.

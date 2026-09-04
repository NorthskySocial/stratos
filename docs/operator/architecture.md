<script setup>
import StratosFlowDiagram from '../.vitepress/theme/components/StratosFlowDiagram.vue'
</script>

# Operator Architecture

<StratosFlowDiagram />

## Trust boundaries

The Stratos service is authoritative for enrollment, record custody, and live access checks. Its storage contains private records and signing material. Protect it as a data service.

The feed generator is a derived, privileged consumer. It holds a local projection for configured feeds and uses service-auth credentials to subscribe and hydrate records. It must not receive a broader boundary grant than its feeds require.

The user PDS remains responsible for user authorization. A proxied feed request carries a short-lived service-auth JWT from the PDS to the feed generator. The feed generator verifies that identity before it reads its projection.

## Failure handling

- A Stratos outage prevents authoritative reads and writes.
- A feed generator outage does not change Stratos records. It makes its derived feeds unavailable or stale until subscription recovery completes.
- A subscription reconnect requires reconciliation before the feed generator reports readiness for a protected projection.
- A boundary removal must purge derived state and invalidate cached membership before a feed is served.

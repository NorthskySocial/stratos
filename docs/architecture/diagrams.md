# System Diagrams

<script setup>
import SystemOverviewAnimation from '../.vitepress/theme/components/SystemOverviewAnimation.vue'
import AppviewHydration from '../.vitepress/theme/components/AppviewHydration.vue'
import AllowlistFlowAnimation from '../.vitepress/theme/components/AllowlistFlowAnimation.vue'
import FeedgenIndexingFlow from '../.vitepress/theme/components/FeedgenIndexingFlow.vue'
</script>

Four pictures of Stratos, each showing one flow. Every diagram has a page that
explains it in full.

## System architecture

<SystemOverviewAnimation />

Stratos sits between a member's PDS and the feed generator. It keeps
enrollments and boundaries, and it stores records for members without a
spaces-capable PDS. See [Architecture](/operator/architecture).

## Record hydration sequence

<AppviewHydration />

An app finds the member's Stratos service through the enrollment record on the
member's PDS. It then asks Stratos for records with the viewer's credential.
See [Hydration Architecture](/architecture/hydration).

## Enrollment and allowlist

<AllowlistFlowAnimation />

A person signs in through OAuth. Stratos checks the enrollment mode and the
allow lists, stores the enrollment, and publishes the enrollment record. See
[Enrollment Signing](/architecture/enrollment-signing).

## Feed generator sync

<FeedgenIndexingFlow />

The feed generator has two sources. It subscribes to the Stratos sync stream
for records Stratos hosts. It polls the PDS of each member whose own PDS hosts
their records. It keeps what it may read in its own encrypted store and serves
feeds from there. See [Feed Generator](/architecture/feed-generator).

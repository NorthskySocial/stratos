---
audience: Operators
type: Overview
status: current
---

# Overview

<script setup>
import DataFlowAnimation from '../.vitepress/theme/components/DataFlowAnimation.vue'
</script>

Stratos lets AT Protocol communities share posts with approved members. A
<Term name="boundary">boundary</Term> is an access group: a viewer must
belong to a post's boundary to read it. People keep their existing AT Protocol
accounts. They join through <Term name="enrollment">enrollment</Term>, and
their <Term name="custody">custody</Term> decides where their posts are kept.

As the operator, you run the service that keeps the member list. You decide
which boundaries exist and who may join them.

The words used here, such as boundary, enrollment, and custody, are defined
in the [Glossary](/reference/glossary). [Core concepts](/guide/concepts)
explains how they fit together.

## Use cases

- **Community-private feeds.** Fandom and community social feeds.
- **Gated communities.** Content visible only to approved members.
- **Multi-community platforms.** Apps with separate data for each community.

## Service components

| Component            | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `stratos-service`    | XRPC and HTTP service: enrollment, boundaries, record storage, sync stream, admin interface |
| `stratos-feedgen-ng` | Rust feed generator: stores private posts locally and serves feeds by current membership    |

The TypeScript feed generator and the standalone indexer are deprecated. See
[Run the feed generator](/operator/feedgen-ng) for the current feed architecture.

## Request flow

<DataFlowAnimation />

A member enrolls with Stratos, and Stratos publishes their enrollment record to
their PDS. The member writes posts. The feed generator collects the posts it
may read, from Stratos and from members' own PDS hosts. A client app asks the
feed generator for a feed and receives only the posts its viewer may read.

## Launch checklist

Launching a service takes you across several pages. Each step links to the
page that does it.

<LaunchChecklist />

## Next steps

- [System architecture](/operator/architecture): components, custody, storage layout
- [Deployment](/operator/deployment): step-by-step production setup
- [Configuration](/operator/configuration): every environment variable
- [Manage boundaries](/operator/boundaries): the admin interface
- [Operations](/operator/operations): monitoring, backup, scaling

---
layout: home

hero:
  name: Stratos
  text: Private permissioned data for ATProtocol
  tagline: Store boundary-scoped records off the PDS, serve them through AppViews with cryptographic access control.
  image:
    src: /icon.svg
    alt: Stratos
  actions:
    - theme: brand
      text: Get Started
      link: /guide/introduction
    - theme: alt
      text: Client Integration
      link: /client/getting-started
    - theme: alt
      text: Operator Guide
      link: /operator/overview

features:
  - icon: 🔐
    title: Boundary Access Control
    details: Records carry domain boundaries. A viewer can only access content when they share at least one boundary with the record.
  - icon: 🪪
    title: OAuth Enrollment
    details: Users enroll via standard ATProtocol OAuth. An enrollment record is published to their PDS for endpoint discovery.
  - icon: 🔗
    title: Source Field Hydration
    details: Minimal stub records on the PDS carry a source field. AppViews resolve full content from Stratos with boundary checks.
  - icon: 🔑
    title: Cryptographic Attestations
    details: Every enrollment is attested by the service signing key over a DAG-CBOR payload, enabling offline verification.
---

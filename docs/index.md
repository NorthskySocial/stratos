---
layout: home

hero:
  name: Stratos
  text: Private permissioned data for ATprotocol
  tagline: Share private posts with approved members using your AT Protocol identity.
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
    details: Posts belong to access groups called boundaries. Only members of a matching group can read them.
  - icon: 🪪
    title: OAuth Enrollment
    details: Users enroll via standard ATprotocol OAuth. An enrollment record is published to their PDS for endpoint discovery.
  - icon: 🔗
    title: Private Record Reads
    details: Apps find the right service through enrollment records and receive full posts only after an access check.
---

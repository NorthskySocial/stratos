---
layout: home

hero:
  name: Stratos
  text: Private data with AT Protocol identity
  tagline: Store access-controlled records in an AT Protocol-compatible repository. Use spaces and boundaries to limit access without creating a second identity system.
  actions:
    - theme: brand
      text: Read the guide
      link: /guide/introduction
    - theme: alt
      text: Integrate a client
      link: /client/getting-started
    - theme: alt
      text: Run a service
      link: /operator/overview

features:
  - icon:
      src: /icons/lock.svg
      alt: Boundary-scoped access
    title: Boundary-scoped access
    details: A record is available only when the requester has current membership in a shared boundary.
  - icon:
      src: /icons/link.svg
      alt: AT Protocol repository
    title: AT Protocol repositories
    details: Each enrolled actor has a signed repository. Records, CAR export, and inclusion proofs remain protocol-native.
  - icon:
      src: /icons/cloud.svg
      alt: Feed generator
    title: Feed generator delivery
    details: A feed generator maintains a local projection and returns fully hydrated, boundary-scoped feed views.
---

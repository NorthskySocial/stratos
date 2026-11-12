<template>
  <FlowDiagram
    title="The parts of a Stratos deployment"
    :cols="3"
    :nodes="nodes"
    :edges="edges"
    :steps="steps"
  />
</template>

<script setup>
import FlowDiagram from './FlowDiagram.vue'

const nodes = [
  {
    id: 'apps',
    title: 'Client apps',
    sub: 'enroll, write, read',
    col: 0,
    row: 0,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'members and records',
    col: 1,
    row: 0,
  },
  {
    id: 'pds',
    title: 'Member PDSs',
    sub: 'enrollment, spaces',
    col: 1,
    row: 1,
  },
  {
    id: 'storage',
    title: 'Storage',
    sub: 'database and blobs',
    col: 2,
    row: 0,
  },
  {
    id: 'feedgen',
    title: 'Feed generator',
    sub: 'encrypted copy',
    col: 2,
    row: 1,
  },
]

const edges = [
  {
    id: 'use',
    from: 'apps',
    to: 'stratos',
  },
  {
    id: 'store',
    from: 'stratos',
    to: 'storage',
  },
  {
    id: 'enr',
    from: 'stratos',
    to: 'pds',
  },
  {
    id: 'sync',
    from: 'stratos',
    to: 'feedgen',
  },
  {
    id: 'poll',
    from: 'feedgen',
    to: 'pds',
  },
  {
    id: 'forward',
    from: 'pds',
    to: 'feedgen',
  },
  {
    id: 'feeds',
    from: 'apps',
    to: 'pds',
  },
]

const steps = [
  {
    text: 'Apps talk to Stratos to enroll members, write records, and read them.',
    edges: ['use'],
  },
  {
    text: 'Stratos keeps repositories in SQLite or Postgres, and attachments on disk or in S3.',
    edges: ['store'],
  },
  {
    text: "Stratos publishes each member's enrollment record to their PDS. A PDS that can host spaces also keeps that member's posts.",
    edges: ['enr'],
  },
  {
    text: 'The feed generator follows Stratos for members and their posts, and polls the PDSs that keep their own.',
    edges: ['sync', 'poll'],
  },
  {
    text: "Apps read private feeds through the member's PDS, which forwards the request to the feed generator.",
    edges: ['feeds', 'forward'],
  },
]
</script>

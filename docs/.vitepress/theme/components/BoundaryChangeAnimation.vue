<template>
  <FlowDiagram
    title="What happens when a member's boundaries change"
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
    id: 'op',
    title: 'Operator',
    sub: 'admin interface',
    col: 0,
    row: 0,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'enrollment store',
    col: 1,
    row: 0,
  },
  {
    id: 'pds',
    title: "Member's PDS",
    sub: 'enrollment record',
    col: 2,
    row: 0,
  },
  {
    id: 'feedgen',
    title: 'Feed generator',
    sub: 'membership cache',
    col: 1,
    row: 1,
  },
]

const edges = [
  {
    id: 'change',
    from: 'op',
    to: 'stratos',
  },
  {
    id: 'rewrite',
    from: 'stratos',
    to: 'pds',
  },
  {
    id: 'event',
    from: 'stratos',
    to: 'feedgen',
  },
]

const steps = [
  {
    text: 'The operator adds or removes a boundary for a member.',
    edges: ['change'],
  },
  {
    text: 'Stratos stores the change and signs a new attestation.',
    nodes: ['stratos'],
  },
  {
    text: "Stratos rewrites the enrollment record on the member's PDS.",
    edges: ['rewrite'],
  },
  {
    text: 'Stratos announces the change on the sync stream. The feed generator drops what it remembered about that member.',
    edges: ['event'],
  },
  {
    text: "The next feed request uses the member's new boundaries.",
    nodes: ['feedgen'],
    tone: 'ok',
  },
]
</script>

<template>
  <FlowDiagram
    title="How Stratos stores a new record"
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
    id: 'client',
    title: 'Client app',
    sub: 'createRecord',
    col: 0,
    row: 0,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'validates and signs',
    col: 1,
    row: 0,
  },
  {
    id: 'store',
    title: 'Actor store',
    sub: 'repository blocks',
    col: 2,
    row: 0,
  },
  {
    id: 'stream',
    title: 'Sync stream',
    sub: 'subscribeRecords',
    col: 1,
    row: 1,
  },
]

const edges = [
  {
    id: 'write',
    from: 'client',
    to: 'stratos',
  },
  {
    id: 'persist',
    from: 'stratos',
    to: 'store',
  },
  {
    id: 'emit',
    from: 'stratos',
    to: 'stream',
  },
  {
    id: 'reply',
    from: 'stratos',
    to: 'client',
    tone: 'ok',
  },
]

const steps = [
  {
    text: "The app sends createRecord with the member's DPoP-bound session.",
    edges: ['write'],
  },
  {
    text: 'Stratos checks the enrollment and the one boundary on the record.',
    nodes: ['stratos'],
  },
  {
    text: "Stratos builds a commit, signs it with the member's per-actor key, and stores the blocks.",
    edges: ['persist'],
  },
  {
    text: 'Stratos announces the change on the sync stream.',
    edges: ['emit'],
  },
  {
    text: 'The app gets the record URI and CID back.',
    edges: ['reply'],
    tone: 'ok',
  },
]
</script>

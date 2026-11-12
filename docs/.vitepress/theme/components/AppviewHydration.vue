<template>
  <FlowDiagram
    title="How an app hydrates private records"
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
    id: 'app',
    title: 'Client app',
    sub: "the viewer's session",
    col: 1,
    row: 0,
  },
  {
    id: 'pds',
    title: "Author's PDS",
    sub: 'enrollment record',
    col: 0,
    row: 0,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'holds the records',
    col: 2,
    row: 0,
  },
]

const edges = [
  {
    id: 'find',
    from: 'app',
    to: 'pds',
  },
  {
    id: 'ask',
    from: 'app',
    to: 'stratos',
  },
  {
    id: 'reply',
    from: 'stratos',
    to: 'app',
    tone: 'ok',
  },
]

const steps = [
  {
    text: "The app reads the author's enrollment record to learn which Stratos service to ask.",
    edges: ['find'],
  },
  {
    text: "The app asks Stratos for up to 100 records in one call, with the viewer's session.",
    edges: ['ask'],
  },
  {
    text: "Stratos compares each record's boundary with the viewer's boundaries.",
    nodes: ['stratos'],
  },
  {
    text: 'Stratos returns the records the viewer may read, and lists the rest as blocked or not found.',
    edges: ['reply'],
    tone: 'ok',
  },
]
</script>

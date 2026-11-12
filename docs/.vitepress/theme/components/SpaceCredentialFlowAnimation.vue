<template>
  <FlowDiagram
    title="How a reader gets into a space"
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
    title: 'Reader',
    sub: 'member or service',
    col: 1,
    row: 0,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'space authority',
    col: 0,
    row: 0,
  },
  {
    id: 'host',
    title: 'Repo host',
    sub: 'Stratos or a PDS',
    col: 2,
    row: 0,
  },
]

const edges = [
  {
    id: 'ask',
    from: 'client',
    to: 'stratos',
  },
  {
    id: 'cred',
    from: 'stratos',
    to: 'client',
    tone: 'ok',
  },
  {
    id: 'read',
    from: 'client',
    to: 'host',
  },
  {
    id: 'rec',
    from: 'host',
    to: 'client',
    tone: 'ok',
  },
]

const steps = [
  {
    text: 'The reader asks Stratos for a credential for one space, and proves it holds a key.',
    edges: ['ask'],
  },
  {
    text: 'Stratos checks that the member is enrolled in that boundary right now. A gated space also checks the app.',
    nodes: ['stratos'],
  },
  {
    text: "Stratos returns a short-lived credential bound to the reader's key.",
    edges: ['cred'],
    tone: 'ok',
  },
  {
    text: 'The reader shows the credential to the repo host, with fresh proof of the same key.',
    edges: ['read'],
  },
  {
    text: "The host checks the authority's signature and the proof. It does not call Stratos.",
    nodes: ['host'],
  },
  {
    text: 'The host returns records from that space only.',
    edges: ['rec'],
    tone: 'ok',
  },
]
</script>

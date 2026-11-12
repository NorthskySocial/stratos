<template>
  <FlowDiagram
    title="How an app verifies an enrollment"
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
    title: 'App',
    sub: 'the verifier',
    col: 1,
    row: 0,
  },
  {
    id: 'pds',
    title: "User's PDS",
    sub: 'enrollment record',
    col: 0,
    row: 0,
  },
  {
    id: 'did',
    title: 'Stratos DID doc',
    sub: 'service key',
    col: 2,
    row: 0,
  },
]

const edges = [
  {
    id: 'read',
    from: 'app',
    to: 'pds',
  },
  {
    id: 'resolve',
    from: 'app',
    to: 'did',
  },
]

const steps = [
  {
    text: 'The app starts from the Stratos service DID it expects. It does not take the DID from the record.',
    nodes: ['app'],
  },
  {
    text: "It reads the enrollment record from the user's PDS.",
    edges: ['read'],
  },
  {
    text: 'It resolves the service DID document for the service key. An older attestation is checked through the key history.',
    edges: ['resolve'],
  },
  {
    text: 'It rebuilds the signed payload from the record and verifies the signature.',
    nodes: ['app'],
  },
  {
    text: 'The enrollment is verified. The app can trust the boundaries and the signing key in it.',
    nodes: ['app'],
    tone: 'ok',
  },
]
</script>

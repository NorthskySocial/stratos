<template>
  <FlowDiagram
    title="What the enrollment attestation proves"
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
    id: 'key',
    title: 'Service key',
    sub: 'Stratos DID document',
    col: 0,
    row: 0,
  },
  {
    id: 'att',
    title: 'Attestation',
    sub: 'signed by Stratos',
    col: 1,
    row: 0,
  },
  {
    id: 'rec',
    title: 'Enrollment',
    sub: "record on user's PDS",
    col: 2,
    row: 0,
  },
  {
    id: 'app',
    title: 'Any app',
    sub: 'the verifier',
    col: 1,
    row: 1,
  },
]

const edges = [
  {
    id: 'sign',
    from: 'key',
    to: 'att',
  },
  {
    id: 'pub',
    from: 'att',
    to: 'rec',
  },
  {
    id: 'read',
    from: 'app',
    to: 'rec',
  },
  {
    id: 'resolve',
    from: 'app',
    to: 'key',
  },
]

const steps = [
  {
    text: "Stratos signs an attestation with its service key. It covers the user's DID, boundaries, and signing key.",
    edges: ['sign'],
  },
  {
    text: "The attestation is published inside the enrollment record record on user's PDS.",
    edges: ['pub'],
  },
  {
    text: 'Any app can read that record.',
    edges: ['read'],
  },
  {
    text: 'The app resolves the Stratos DID document and checks the signature against the service key.',
    edges: ['resolve'],
  },
  {
    text: 'The app now knows that Stratos enrolled this user. That is not permission to read posts.',
    nodes: ['app'],
    tone: 'ok',
  },
]
</script>

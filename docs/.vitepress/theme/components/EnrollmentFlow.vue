<template>
  <FlowDiagram
    title="How a user enrolls with a Stratos service"
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
    id: 'user',
    title: 'User',
    sub: 'existing account',
    col: 0,
    row: 0,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'the service to join',
    col: 1,
    row: 0,
  },
  {
    id: 'pds',
    title: "User's PDS",
    sub: 'signs the user in',
    col: 2,
    row: 0,
  },
]

const edges = [
  {
    id: 'join',
    from: 'user',
    to: 'stratos',
  },
  {
    id: 'pds',
    from: 'stratos',
    to: 'pds',
  },
]

const steps = [
  {
    text: 'The user asks to join.',
    edges: ['join'],
  },
  {
    text: 'Stratos sends them to their own PDS to sign in and approve the request (OAuth).',
    edges: ['pds'],
  },
  {
    text: 'Stratos checks the allowlist and records the boundaries the user holds.',
    nodes: ['stratos'],
  },
  {
    text: "Stratos works out custody. A PDS that can host spaces keeps the user's posts. Otherwise Stratos keeps them and creates a signing key for the user.",
    nodes: ['stratos'],
  },
  {
    text: "Stratos signs an attestation and publishes the enrollment record to the user's PDS.",
    edges: ['pds'],
    tone: 'ok',
  },
]
</script>

<template>
  <FlowDiagram
    title="How the allowlist gates enrollment"
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
    title: 'Person',
    sub: 'signs in with OAuth',
    col: 0,
    row: 0,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'enrollment mode',
    col: 1,
    row: 0,
  },
  {
    id: 'list',
    title: 'Allowlist',
    sub: 'DIDs, PDS hosts',
    col: 2,
    row: 0,
  },
  {
    id: 'pds',
    title: "Person's PDS",
    sub: 'enrollment record',
    col: 1,
    row: 1,
  },
]

const edges = [
  {
    id: 'join',
    from: 'user',
    to: 'stratos',
  },
  {
    id: 'check',
    from: 'stratos',
    to: 'list',
  },
  {
    id: 'publish',
    from: 'stratos',
    to: 'pds',
    tone: 'ok',
  },
  {
    id: 'deny',
    from: 'stratos',
    to: 'user',
    tone: 'deny',
  },
]

const steps = [
  {
    text: 'A person signs in and asks to enroll.',
    edges: ['join'],
  },
  {
    text: 'In allowlist mode, Stratos checks their DID and their PDS against the allowlist. In open mode it skips this check.',
    edges: ['check'],
  },
  {
    text: "Listed: Stratos stores the enrollment and publishes the enrollment record to the person's PDS.",
    edges: ['publish'],
    tone: 'ok',
  },
  {
    text: 'Not listed: Stratos answers EnrollmentDenied and writes nothing.',
    edges: ['deny'],
    tone: 'deny',
  },
]
</script>

<template>
  <FlowDiagram
    title="A private post from writer to reader"
    :cols="4"
    :nodes="nodes"
    :edges="edges"
    :steps="steps"
  />
</template>

<script setup>
import FlowDiagram from './FlowDiagram.vue'

const nodes = [
  {
    id: 'member',
    title: 'Member',
    sub: 'writes a post',
    col: 0,
    row: 0,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'authority',
    col: 1,
    row: 0,
  },
  {
    id: 'pds',
    title: "Member's PDS",
    sub: 'own repository',
    col: 1,
    row: 1,
  },
  {
    id: 'feedgen',
    title: 'Feed generator',
    sub: 'local copy',
    col: 2,
    row: 0,
  },
  {
    id: 'viewer',
    title: 'Viewer',
    sub: 'opens a feed',
    col: 3,
    row: 0,
  },
]

const edges = [
  {
    id: 'toS',
    from: 'member',
    to: 'stratos',
  },
  {
    id: 'toP',
    from: 'member',
    to: 'pds',
  },
  {
    id: 'rec',
    from: 'stratos',
    to: 'pds',
  },
  {
    id: 'sS',
    from: 'stratos',
    to: 'feedgen',
  },
  {
    id: 'sP',
    from: 'pds',
    to: 'feedgen',
  },
  {
    id: 'ask',
    from: 'viewer',
    to: 'feedgen',
  },
  {
    id: 'feed',
    from: 'feedgen',
    to: 'viewer',
    tone: 'ok',
  },
]

const steps = [
  {
    text: 'A member enrolls. Stratos publishes their enrollment record to their PDS.',
    edges: ['toS', 'rec'],
  },
  {
    text: 'The member writes a post. Custody decides where it goes: to Stratos, or to their own PDS.',
    edges: ['toS', 'toP'],
  },
  {
    text: 'The feed generator collects posts from both places, for the members Stratos lists.',
    edges: ['sS', 'sP'],
  },
  {
    text: "A viewer asks for a feed. The request arrives through the viewer's own PDS.",
    edges: ['ask'],
  },
  {
    text: "The feed generator checks the viewer's membership with Stratos, then returns the posts they may read.",
    edges: ['feed'],
    tone: 'ok',
  },
]
</script>

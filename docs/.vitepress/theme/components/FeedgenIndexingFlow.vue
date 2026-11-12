<template>
  <FlowDiagram
    title="How the feed generator collects posts"
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
    id: 'stratos',
    title: 'Stratos',
    sub: 'authority',
    col: 0,
    row: 0,
  },
  {
    id: 'pds',
    title: "Member's PDS",
    sub: 'keeps its own posts',
    col: 1,
    row: 1,
  },
  {
    id: 'feedgen',
    title: 'Feed generator',
    sub: 'reads and verifies',
    col: 1,
    row: 0,
  },
  {
    id: 'copy',
    title: 'Local copy',
    sub: 'encrypted, bounded',
    col: 2,
    row: 0,
  },
]

const edges = [
  {
    id: 'stream',
    from: 'stratos',
    to: 'feedgen',
  },
  {
    id: 'poll',
    from: 'feedgen',
    to: 'pds',
  },
  {
    id: 'ops',
    from: 'pds',
    to: 'feedgen',
  },
  {
    id: 'store',
    from: 'feedgen',
    to: 'copy',
    tone: 'ok',
  },
]

const steps = [
  {
    text: 'Stratos tells the feed generator who the members are, and when that changes.',
    edges: ['stream'],
  },
  {
    text: 'For members whose posts Stratos keeps, Stratos streams each change.',
    edges: ['stream'],
  },
  {
    text: 'For members who keep their own posts, the feed generator polls their PDS with a credential from Stratos.',
    edges: ['poll'],
  },
  {
    text: 'It holds those changes aside until the commit signature verifies.',
    edges: ['ops'],
  },
  {
    text: 'Verified posts enter the local copy, filed under the boundary Stratos vouches for.',
    edges: ['store'],
    tone: 'ok',
  },
]
</script>

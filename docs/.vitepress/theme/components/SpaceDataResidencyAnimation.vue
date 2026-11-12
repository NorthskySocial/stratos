<template>
  <FlowDiagram
    title="Where a private post is kept"
    :cols="2"
    :nodes="nodes"
    :edges="edges"
    :steps="steps"
  />
</template>

<script setup>
import FlowDiagram from './FlowDiagram.vue'

const nodes = [
  {
    id: 'a',
    title: 'Member A',
    sub: 'PDS without spaces',
    col: 0,
    row: 0,
  },
  {
    id: 'b',
    title: 'Member B',
    sub: 'PDS with spaces',
    col: 0,
    row: 1,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'keeps A’s posts',
    col: 1,
    row: 0,
  },
  {
    id: 'pds',
    title: "B's PDS",
    sub: 'keeps B’s posts',
    col: 1,
    row: 1,
  },
]

const edges = [
  {
    id: 'wa',
    from: 'a',
    to: 'stratos',
  },
  {
    id: 'wb',
    from: 'b',
    to: 'pds',
  },
  {
    id: 'member',
    from: 'stratos',
    to: 'pds',
  },
]

const steps = [
  {
    text: "Member A's PDS cannot host spaces. A writes the post to Stratos. Stratos keeps it and signs it with a key it holds for A.",
    edges: ['wa'],
  },
  {
    text: "Member B's PDS can host spaces. B writes the post into a protected space on their own PDS.",
    edges: ['wb'],
  },
  {
    text: "Stratos still decides who belongs to that space. It issues the credentials that readers show to B's PDS.",
    edges: ['member'],
  },
  {
    text: 'Neither post reaches the public firehose.',
    nodes: ['stratos', 'pds'],
    tone: 'ok',
  },
]
</script>

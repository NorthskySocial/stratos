<template>
  <FlowDiagram
    title="Who can read a post"
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
    id: 'alice',
    title: 'Alice',
    sub: 'cooking, hiking',
    col: 0,
    row: 0,
  },
  {
    id: 'bob',
    title: 'Bob',
    sub: 'in cooking only',
    col: 1,
    row: 1,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'checks membership',
    col: 1,
    row: 0,
  },
  {
    id: 'post',
    title: 'Post',
    sub: 'boundary: hiking',
    col: 2,
    row: 0,
  },
]

const edges = [
  {
    id: 'a1',
    from: 'alice',
    to: 'stratos',
  },
  {
    id: 'lookup',
    from: 'stratos',
    to: 'post',
  },
  {
    id: 'a2',
    from: 'stratos',
    to: 'alice',
    tone: 'ok',
  },
  {
    id: 'b1',
    from: 'bob',
    to: 'stratos',
  },
  {
    id: 'b2',
    from: 'stratos',
    to: 'bob',
    tone: 'deny',
  },
]

const steps = [
  {
    text: 'Alice asks for a post.',
    edges: ['a1'],
  },
  {
    text: 'The post belongs to the hiking boundary. Alice is a member of hiking.',
    edges: ['lookup'],
  },
  {
    text: 'Alice gets the post.',
    edges: ['a2'],
    tone: 'ok',
  },
  {
    text: 'Bob asks for the same post. He is only in cooking.',
    edges: ['b1'],
  },
  {
    text: 'Bob gets "not found", the same answer as for a post that does not exist.',
    edges: ['b2'],
    tone: 'deny',
  },
]
</script>

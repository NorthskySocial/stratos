<template>
  <FlowDiagram
    title="How a viewer opens a private feed"
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
    sub: 'the viewer',
    col: 0,
    row: 0,
  },
  {
    id: 'pds',
    title: "Viewer's PDS",
    sub: 'forwards the request',
    col: 1,
    row: 0,
  },
  {
    id: 'feedgen',
    title: 'Feed generator',
    sub: 'encrypted copy',
    col: 2,
    row: 0,
  },
  {
    id: 'stratos',
    title: 'Stratos',
    sub: 'knows the members',
    col: 2,
    row: 1,
  },
]

const edges = [
  {
    id: 'ask',
    from: 'app',
    to: 'pds',
  },
  {
    id: 'forward',
    from: 'pds',
    to: 'feedgen',
  },
  {
    id: 'check',
    from: 'feedgen',
    to: 'stratos',
  },
  {
    id: 'back1',
    from: 'feedgen',
    to: 'pds',
    tone: 'ok',
  },
  {
    id: 'back2',
    from: 'pds',
    to: 'app',
    tone: 'ok',
  },
]

const steps = [
  {
    text: 'The app asks its own PDS for the feed and names the feed generator.',
    edges: ['ask'],
  },
  {
    text: 'The PDS forwards the request with a short-lived token that says who is asking.',
    edges: ['forward'],
  },
  {
    text: 'The feed generator asks Stratos which boundaries the viewer holds. It keeps the answer for five minutes.',
    edges: ['check'],
  },
  {
    text: 'It reads the posts of that boundary from its own encrypted copy.',
    nodes: ['feedgen'],
  },
  {
    text: 'Only posts from boundaries the viewer holds come back.',
    edges: ['back1', 'back2'],
    tone: 'ok',
  },
]
</script>

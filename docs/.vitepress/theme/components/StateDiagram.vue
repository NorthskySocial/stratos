<template>
  <figure class="state">
    <svg
      class="state-svg"
      :viewBox="`0 0 ${WIDTH} ${height}`"
      role="img"
      :aria-label="title"
    >
      <defs>
        <marker
          :id="`${uid}-head`"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path class="head" d="M0 0 L8 4 L0 8 Z" />
        </marker>
      </defs>

      <g v-for="edge in drawnEdges" :key="edge.key" class="edge">
        <path class="edge-line" :d="edge.d" :marker-end="`url(#${uid}-head)`" />
        <text class="edge-label" :x="edge.lx" :y="edge.ly">
          {{ edge.label }}
        </text>
      </g>

      <g
        v-for="node in drawnNodes"
        :key="node.id"
        class="node"
        :class="`tone-${node.tone ?? 'default'}`"
        :transform="`translate(${node.x} ${TOP})`"
      >
        <rect class="node-box" :width="NODE_W" :height="NODE_H" rx="10" />
        <text class="node-title" :x="NODE_W / 2" :y="node.sub ? 25 : 34">
          {{ node.title }}
        </text>
        <text v-if="node.sub" class="node-sub" :x="NODE_W / 2" y="44">
          {{ node.sub }}
        </text>
      </g>
    </svg>

    <figcaption class="state-caption">
      <p class="state-title">{{ title }}</p>
      <ul class="state-moves">
        <li v-for="edge in transitions" :key="`${edge.from}-${edge.to}`">
          <strong>{{ nameOf(edge.from) }}</strong> to
          <strong>{{ nameOf(edge.to) }}</strong
          >: {{ edge.label }}
        </li>
      </ul>
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'

interface StateNode {
  id: string
  title: string
  sub?: string
  tone?: 'default' | 'ok' | 'deny'
}

interface StateTransition {
  from: string
  to: string
  label: string
}

const props = defineProps<{
  title: string
  states: StateNode[]
  transitions: StateTransition[]
}>()

const WIDTH = 640
const NODE_W = 150
const NODE_H = 56
const TOP = 40
const LOOP_GAP = 34
const LABEL_LIFT = 10

const uid = useId()

const spacing = computed(
  () => (WIDTH - NODE_W) / Math.max(props.states.length - 1, 1),
)

const indexOf = (id: string) => props.states.findIndex((s) => s.id === id)
const nameOf = (id: string) => props.states[indexOf(id)]?.title ?? id

const drawnNodes = computed(() =>
  props.states.map((s, i) => ({ ...s, x: i * spacing.value })),
)

// Forward moves are straight lines between neighbours. Moves back to an
// earlier state arc underneath, each one a step lower, so labels never touch.
const backwardCount = computed(
  () =>
    props.transitions.filter((t) => indexOf(t.to) <= indexOf(t.from)).length,
)

const height = computed(
  () => TOP + NODE_H + (backwardCount.value + 1) * LOOP_GAP + 8,
)

const drawnEdges = computed(() => {
  let depth = 0
  return props.transitions.map((t) => {
    const from = indexOf(t.from)
    const to = indexOf(t.to)
    const key = `${t.from}-${t.to}`
    if (to > from) {
      const x1 = from * spacing.value + NODE_W + 4
      const x2 = to * spacing.value - 4
      const y = TOP + NODE_H / 2
      return {
        key,
        label: t.label,
        d: `M${x1} ${y} L${x2} ${y}`,
        lx: (x1 + x2) / 2,
        ly: TOP - LABEL_LIFT,
      }
    }
    depth += 1
    const x1 = from * spacing.value + NODE_W / 2
    const x2 = to * spacing.value + NODE_W / 2
    const y0 = TOP + NODE_H + 4
    const y = y0 + depth * LOOP_GAP - 12
    return {
      key,
      label: t.label,
      d: `M${x1} ${y0} L${x1} ${y} L${x2} ${y} L${x2} ${y0}`,
      lx: (x1 + x2) / 2,
      ly: y + 15,
    }
  })
})
</script>

<style scoped>
.state {
  --sd-line: #6d4fd6;
  --sd-ok: #0b8f63;
  --sd-deny: #cf3a4e;
  margin: 1.5rem 0;
  padding: 16px 16px 12px;
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  container-type: inline-size;
}

.state-svg {
  display: block;
  width: 100%;
  height: auto;
}

@container (max-width: 480px) {
  .node-title {
    font-size: 18px;
    transform: translateY(6px);
  }
  .node-sub {
    display: none;
  }
  .edge-label {
    font-size: 14px;
  }
}

.head {
  fill: var(--sd-line);
}

.edge-line {
  fill: none;
  stroke: var(--sd-line);
  stroke-width: 2;
  stroke-linejoin: round;
}

.edge-label {
  fill: var(--vp-c-text-2);
  font-size: 12px;
  text-anchor: middle;
}

.node-box {
  fill: var(--vp-c-bg);
  stroke: var(--tone);
  stroke-width: 2;
}
.tone-default {
  --tone: var(--sd-line);
}
.tone-ok {
  --tone: var(--sd-ok);
}
.tone-deny {
  --tone: var(--sd-deny);
}

.node-title {
  fill: var(--vp-c-text-1);
  font-size: 15px;
  font-weight: 600;
  text-anchor: middle;
}
.node-sub {
  fill: var(--vp-c-text-2);
  font-size: 12px;
  text-anchor: middle;
}

.state-caption {
  margin-top: 10px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}
.state-title {
  margin: 0 0 4px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}
.state-moves {
  margin: 0;
  padding-left: 1.2rem;
}
.state-moves li + li {
  margin-top: 2px;
}
</style>

<style>
.dark .state {
  --sd-line: #b9a3ff;
  --sd-ok: #2affba;
  --sd-deny: #ff8494;
}
</style>

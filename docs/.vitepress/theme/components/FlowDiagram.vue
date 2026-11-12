<template>
  <figure
    ref="rootRef"
    class="flow"
    :class="{ 'is-static': reducedMotion }"
    @mouseenter="hovering = true"
    @mouseleave="hovering = false"
    @focusin="hovering = true"
    @focusout="hovering = false"
  >
    <svg
      class="flow-svg"
      :viewBox="`0 0 ${WIDTH} ${height}`"
      role="img"
      :aria-label="title"
    >
      <defs>
        <marker
          v-for="tone in TONES"
          :id="`${uid}-${tone}`"
          :key="tone"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path :class="`head tone-${tone}`" d="M0 0 L8 4 L0 8 Z" />
        </marker>
      </defs>

      <g
        v-for="edge in drawnEdges"
        :key="edge.id"
        class="edge"
        :class="[`tone-${edge.tone}`, { active: isEdgeActive(edge.id) }]"
      >
        <path
          class="edge-line"
          :d="edge.d"
          pathLength="1"
          :marker-end="`url(#${uid}-${edge.tone})`"
        />
        <g v-if="edge.label" :transform="`translate(${edge.bx} ${edge.by})`">
          <rect
            class="badge"
            :x="-badgeWidth(edge.label) / 2"
            y="-11"
            :width="badgeWidth(edge.label)"
            height="22"
            rx="11"
          />
          <text class="badge-text" y="4.5">{{ edge.label }}</text>
        </g>
      </g>

      <g
        v-for="node in drawnNodes"
        :key="node.id"
        class="node"
        :class="{ active: isNodeActive(node.id) }"
        :transform="`translate(${node.x} ${node.y})`"
      >
        <rect class="node-box" :width="nodeWidth" :height="NODE_H" rx="10" />
        <text class="node-title" :x="nodeWidth / 2" :y="node.sub ? 26 : 36">
          {{ node.title }}
        </text>
        <text v-if="node.sub" class="node-sub" :x="nodeWidth / 2" y="45">
          {{ node.sub }}
        </text>
        <g
          v-if="node.label"
          class="tone-default"
          :transform="`translate(${nodeWidth - 6} 0)`"
        >
          <rect
            class="badge"
            :x="-badgeWidth(node.label) / 2"
            y="-11"
            :width="badgeWidth(node.label)"
            height="22"
            rx="11"
          />
          <text class="badge-text" y="4.5">{{ node.label }}</text>
        </g>
      </g>
    </svg>

    <figcaption class="flow-caption">
      <ol class="flow-steps">
        <li v-for="(step, i) in steps" :key="i">
          <button
            type="button"
            class="flow-step"
            :class="[
              `tone-${step.tone ?? 'default'}`,
              { active: i === active },
            ]"
            :aria-current="i === active ? 'step' : undefined"
            @click="select(i)"
          >
            <span class="flow-step-num">{{ i + 1 }}</span>
            <span class="flow-step-text">{{ step.text }}</span>
          </button>
        </li>
      </ol>
    </figcaption>
  </figure>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

const props = defineProps({
  title: { type: String, required: true },
  cols: { type: Number, default: 3 },
  nodes: { type: Array, required: true },
  edges: { type: Array, default: () => [] },
  steps: { type: Array, required: true },
})

const TONES = ['default', 'ok', 'deny']
const PAD_X = 12
const PAD_Y = 22
const NODE_H = 60
const ROW_GAP = 112
const EDGE_GAP = 5
const PARALLEL_OFFSET = 12
const BADGE_AT = 0.5
const STEP_MS = 3400

const uid = useId()
const rootRef = ref(null)
const active = ref(0)
const hovering = ref(false)
const visible = ref(false)
const pinned = ref(false)
const reducedMotion = ref(false)

const WIDTH = props.cols > 3 ? 840 : 640
const colWidth = computed(() => (WIDTH - PAD_X * 2) / props.cols)
const nodeWidth = computed(() => colWidth.value - 64)
const height = computed(() => {
  const maxRow = Math.max(...props.nodes.map((n) => n.row))
  return PAD_Y * 2 + NODE_H + maxRow * ROW_GAP
})

const centers = computed(() => {
  const map = {}
  for (const n of props.nodes) {
    map[n.id] = {
      cx: PAD_X + colWidth.value * (n.col + 0.5),
      cy: PAD_Y + NODE_H / 2 + n.row * ROW_GAP,
    }
  }
  return map
})

function stepNumbers(match) {
  return props.steps
    .map((s, i) => (match(s) ? i + 1 : null))
    .filter((n) => n !== null)
    .join(' · ')
}

const drawnNodes = computed(() =>
  props.nodes.map((n) => ({
    ...n,
    x: centers.value[n.id].cx - nodeWidth.value / 2,
    y: centers.value[n.id].cy - NODE_H / 2,
    label: stepNumbers((s) => !s.edges?.length && s.nodes?.includes(n.id)),
  })),
)

function exitDistance(dx, dy, ox, oy) {
  const halfW = nodeWidth.value / 2 + EDGE_GAP
  const halfH = NODE_H / 2 + EDGE_GAP
  const tx = dx === 0 ? Infinity : ((dx > 0 ? halfW : -halfW) - ox) / dx
  const ty = dy === 0 ? Infinity : ((dy > 0 ? halfH : -halfH) - oy) / dy
  return Math.min(tx, ty)
}

const drawnEdges = computed(() =>
  props.edges.map((e) => {
    const a = centers.value[e.from]
    const b = centers.value[e.to]
    const len = Math.hypot(b.cx - a.cx, b.cy - a.cy)
    const dx = (b.cx - a.cx) / len
    const dy = (b.cy - a.cy) / len
    const hasReverse = props.edges.some(
      (o) => o.from === e.to && o.to === e.from,
    )
    const ox = hasReverse ? -dy * PARALLEL_OFFSET : 0
    const oy = hasReverse ? dx * PARALLEL_OFFSET : 0
    const t1 = exitDistance(dx, dy, ox, oy)
    const t2 = exitDistance(-dx, -dy, ox, oy)
    const x1 = a.cx + ox + dx * t1
    const y1 = a.cy + oy + dy * t1
    const x2 = b.cx + ox - dx * t2
    const y2 = b.cy + oy - dy * t2
    const r = (v) => Math.round(v * 10) / 10
    return {
      id: e.id,
      tone: e.tone ?? 'default',
      d: `M${r(x1)} ${r(y1)} L${r(x2)} ${r(y2)}`,
      bx: r(x1 + (x2 - x1) * BADGE_AT),
      by: r(y1 + (y2 - y1) * BADGE_AT),
      label: stepNumbers((s) => s.edges?.includes(e.id)),
    }
  }),
)

function badgeWidth(label) {
  return Math.max(22, 12 + label.length * 6.5)
}

const activeStep = computed(() => props.steps[active.value])

function isEdgeActive(id) {
  return activeStep.value.edges?.includes(id) ?? false
}

function isNodeActive(id) {
  const step = activeStep.value
  if (step.nodes?.includes(id)) return true
  return props.edges.some(
    (e) => step.edges?.includes(e.id) && (e.from === id || e.to === id),
  )
}

function select(i) {
  active.value = i
  pinned.value = true
}

let timer
function stop() {
  clearTimeout(timer)
  timer = undefined
}
function schedule() {
  stop()
  const playing =
    visible.value && !hovering.value && !pinned.value && !reducedMotion.value
  if (!playing) return
  timer = setTimeout(() => {
    active.value = (active.value + 1) % props.steps.length
    schedule()
  }, STEP_MS)
}

watch([visible, hovering, pinned, reducedMotion], schedule)
watch(hovering, (now) => {
  if (!now) pinned.value = false
})

let observer
let motionQuery
function readMotionPreference() {
  reducedMotion.value = motionQuery.matches
}

onMounted(() => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  readMotionPreference()
  motionQuery.addEventListener('change', readMotionPreference)
  observer = new IntersectionObserver(
    ([entry]) => {
      visible.value = entry.isIntersecting
    },
    { threshold: 0.35 },
  )
  observer.observe(rootRef.value)
})

onBeforeUnmount(() => {
  stop()
  observer?.disconnect()
  motionQuery?.removeEventListener('change', readMotionPreference)
})
</script>

<style scoped>
.flow {
  --fd-line: #6d4fd6;
  --fd-ok: #0b8f63;
  --fd-deny: #cf3a4e;
  margin: 1.5rem 0;
  padding: 16px 16px 12px;
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  container-type: inline-size;
}

.flow-svg {
  display: block;
  width: 100%;
  height: auto;
}

/* The drawing scales with its container. On a narrow one, drop the second
   line of each node and enlarge the title so it stays legible. */
@container (max-width: 480px) {
  .node-title {
    font-size: 19px;
    transform: translateY(6px);
  }
  .node-sub {
    display: none;
  }
  .badge-text {
    font-size: 14px;
  }
}

.tone-default {
  --tone: var(--fd-line);
}
.tone-ok {
  --tone: var(--fd-ok);
}
.tone-deny {
  --tone: var(--fd-deny);
}

.head {
  fill: var(--tone);
}

.edge {
  opacity: 0.4;
  transition: opacity 300ms cubic-bezier(0.25, 1, 0.5, 1);
}
.edge.active {
  opacity: 1;
}
.edge-line {
  fill: none;
  stroke: var(--tone);
  stroke-width: 2;
  stroke-linecap: round;
}
.edge.active .edge-line {
  stroke-width: 2.5;
  stroke-dasharray: 1;
  animation: flow-draw 700ms cubic-bezier(0.65, 0, 0.35, 1) both;
}

@keyframes flow-draw {
  from {
    stroke-dashoffset: 1;
  }
  to {
    stroke-dashoffset: 0;
  }
}

.badge {
  fill: var(--vp-c-bg-soft);
  stroke: var(--tone);
  stroke-width: 1.5;
}
.badge-text {
  fill: var(--tone);
  font-size: 12px;
  font-weight: 700;
  text-anchor: middle;
}
.edge.active .badge {
  fill: var(--tone);
}
.edge.active .badge-text {
  fill: var(--vp-c-bg);
}

.node-box {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-divider);
  stroke-width: 1.5;
  transition:
    stroke 300ms cubic-bezier(0.25, 1, 0.5, 1),
    stroke-width 300ms cubic-bezier(0.25, 1, 0.5, 1);
}
.node.active .node-box {
  stroke: var(--fd-line);
  stroke-width: 2.5;
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
.node.active .badge {
  fill: var(--tone);
}
.node.active .badge-text {
  fill: var(--vp-c-bg);
}

.flow-caption {
  margin-top: 10px;
}

.flow-steps {
  list-style: none;
  margin: 0;
  padding: 0;
}
.flow-steps li {
  margin: 0;
}
.flow-steps li + li {
  margin-top: 2px;
}

.flow-step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 8px;
  text-align: left;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
  transition:
    background-color 200ms cubic-bezier(0.25, 1, 0.5, 1),
    color 200ms cubic-bezier(0.25, 1, 0.5, 1);
}
.flow-step:hover {
  color: var(--vp-c-text-1);
}
.flow-step:focus-visible {
  outline: 2px solid var(--fd-line);
  outline-offset: 1px;
}
.flow-step.active {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}

.flow-step-num {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: 0.5px;
  border: 1.5px solid var(--tone);
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
  color: var(--tone);
}
.flow-step.active .flow-step-num {
  background: var(--tone);
  color: var(--vp-c-bg);
}

.is-static .edge {
  opacity: 1;
}
.is-static .edge.active .edge-line {
  animation: none;
  stroke-dasharray: none;
}

@media (prefers-reduced-motion: reduce) {
  .edge,
  .node-box,
  .flow-step {
    transition: none;
  }
  .edge.active .edge-line {
    animation: none;
    stroke-dasharray: none;
  }
}
</style>

<style>
.dark .flow {
  --fd-line: #b9a3ff;
  --fd-ok: #2affba;
  --fd-deny: #ff8494;
}
</style>

<template>
  <div ref="containerRef" class="anim-outer">
    <div ref="stageRef" class="stage">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="is-ml"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#9145EC" points="0 0,7 2.5,0 5" />
          </marker>
          <marker
            id="is-mg"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#24cf6e" points="0 0,7 2.5,0 5" />
          </marker>
        </defs>
        <!-- PDS Firehose → Indexer (diagonal down-right) -->
        <path
          id="is-a1"
          class="ar"
          d="M 190 168 L 355 235"
          marker-end="url(#is-ml)"
          stroke="#9145EC"
        />
        <!-- Stratos Stream → Indexer (diagonal up-right) -->
        <path
          id="is-a2"
          class="ar"
          d="M 190 332 L 355 262"
          marker-end="url(#is-ml)"
          stroke="#9145EC"
        />
        <!-- Indexer → PostgreSQL (diagonal up-right) -->
        <path
          id="is-a3"
          class="ar"
          d="M 520 225 L 645 172"
          marker-end="url(#is-ml)"
          stroke="#9145EC"
        />
        <!-- PostgreSQL → AppView (vertical) -->
        <path
          id="is-a4"
          class="ar"
          d="M 732 203 L 727 295"
          marker-end="url(#is-mg)"
          stroke="#24cf6e"
        />
      </svg>

      <!-- Left column -->
      <div
        id="is-npds"
        class="node"
        style="left: 15px; top: 100px; width: 175px"
      >
        <div class="ni">🔥</div>
        <div class="nn">PDS Firehose</div>
        <div class="ns">subscribeRepos</div>
      </div>

      <div
        id="is-nst"
        class="node"
        style="left: 15px; top: 295px; width: 175px"
      >
        <div class="ni">⚙️</div>
        <div class="nn">Stratos Stream</div>
        <div class="ns">subscribeRecords</div>
      </div>

      <!-- Center: Indexer -->
      <div
        id="is-nix"
        class="node"
        style="left: 355px; top: 195px; width: 165px"
      >
        <div class="ni">🔄</div>
        <div class="nn">Indexer</div>
        <div class="ns">stratos-indexer</div>
      </div>

      <!-- Right column -->
      <div
        id="is-ndb"
        class="node"
        style="left: 645px; top: 100px; width: 195px"
      >
        <div class="ni">🛢️</div>
        <div class="nn">PostgreSQL</div>
        <div class="ns">stratos_post · boundaries</div>
      </div>

      <div
        id="is-nav"
        class="node"
        style="left: 645px; top: 295px; width: 195px"
      >
        <div class="ni">📡</div>
        <div class="nn">AppView</div>
        <div class="ns">zone.stratos.feed.*</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

const containerRef = ref(null)
const stageRef = ref(null)

const $ = (id) => stageRef.value?.querySelector('#' + id)
const add = (el, ...c) => el?.classList.add(...c)
const rm = (el, ...c) => el?.classList.remove(...c)

function fit() {
  if (!containerRef.value || !stageRef.value) return
  const scale = containerRef.value.clientWidth / 900
  stageRef.value.style.transform = `scale(${scale})`
}

const timeouts = []
const later = (fn, ms) => {
  const t = setTimeout(fn, ms)
  timeouts.push(t)
  return t
}

function reset() {
  ;['is-npds', 'is-nst', 'is-nix', 'is-ndb', 'is-nav'].forEach((id) =>
    rm($(id), 'hl', 'ok'),
  )
  ;['is-a1', 'is-a2', 'is-a3', 'is-a4'].forEach((id) => rm($(id), 'show'))
}

const steps = [
  {
    dur: 1600,
    fn() {
      add($('is-npds'), 'hl')
      add($('is-nst'), 'hl')
    },
  },
  {
    dur: 2000,
    fn() {
      rm($('is-npds'), 'hl')
      rm($('is-nst'), 'hl')
      add($('is-nix'), 'hl')
      add($('is-a1'), 'show')
      add($('is-a2'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('is-nix'), 'hl')
      add($('is-ndb'), 'hl')
      add($('is-a3'), 'show')
    },
  },
  {
    dur: 2000,
    fn() {
      rm($('is-ndb'), 'hl')
      add($('is-nav'), 'ok')
      add($('is-a4'), 'show')
    },
  },
]

function run(i) {
  steps[i].fn()
  later(() => {
    const next = (i + 1) % steps.length
    if (next === 0) {
      reset()
      later(() => run(0), 800)
    } else run(next)
  }, steps[i].dur)
}

let ro
onMounted(() => {
  ro = new ResizeObserver(fit)
  ro.observe(containerRef.value)
  fit()
  reset()
  later(() => run(0), 600)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  timeouts.forEach(clearTimeout)
})
</script>

<style scoped>
.anim-outer {
  width: 100%;
  aspect-ratio: 900 / 520;
  position: relative;
  overflow: hidden;
  background: #1f0b35;
  border-radius: 12px;
  margin: 1.5rem 0;
}
.stage {
  position: absolute;
  top: 0;
  left: 0;
  width: 900px;
  height: 520px;
  transform-origin: top left;
  --card: #240d45;
  --bdr: #7780dc;
  --txt: #cdc6ff;
  --dim: #8878b0;
  --blu: #9145ec;
  --grn: #24cf6e;
}
.stage::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 750px;
  height: 440px;
  background: radial-gradient(
    ellipse,
    rgba(80, 20, 130, 0.22) 0%,
    transparent 70%
  );
  pointer-events: none;
}
.node {
  position: absolute;
  background: var(--card);
  border: 1.5px solid var(--bdr);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 12px 14px;
  transition:
    border-color 0.4s,
    box-shadow 0.4s;
}
.ni {
  font-size: 32px;
  line-height: 1;
}
.nn {
  font-size: 15px;
  font-weight: 700;
  color: var(--txt);
  text-align: center;
  white-space: nowrap;
}
.ns {
  font-size: 13px;
  color: var(--dim);
  text-align: center;
  white-space: nowrap;
}
@keyframes is-breathe {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes is-march {
  to {
    stroke-dashoffset: -12;
  }
}
.hl {
  border-color: var(--blu) !important;
  animation: is-breathe 2s ease-in-out infinite;
}
.ok {
  border-color: var(--grn) !important;
  box-shadow: 0 0 24px rgba(36, 207, 110, 0.4) !important;
}
.arsvg {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
.ar {
  fill: none;
  stroke-width: 2;
  stroke-linecap: butt;
  stroke-dasharray: 8 4;
  opacity: 0;
  transition: opacity 0.4s;
}
.ar.show {
  opacity: 1;
  animation: is-march 0.5s linear infinite;
}
</style>

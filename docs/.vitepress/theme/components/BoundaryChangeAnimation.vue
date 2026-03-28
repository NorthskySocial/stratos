<template>
  <div class="anim-outer" ref="containerRef">
    <div class="stage" ref="stageRef">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="bc-ml"
            markerWidth="7"
            markerHeight="5"
            refX="7"
            refY="2.5"
            orient="auto"
          >
            <polygon points="0 0,7 2.5,0 5" fill="#9145EC" />
          </marker>
          <marker
            id="bc-mg"
            markerWidth="7"
            markerHeight="5"
            refX="7"
            refY="2.5"
            orient="auto"
          >
            <polygon points="0 0,7 2.5,0 5" fill="#24cf6e" />
          </marker>
        </defs>
        <!-- Top row: Operator → Stratos → DB -->
        <path
          id="bc-a1"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#bc-ml)"
          d="M 170 133 L 305 133"
        />
        <path
          id="bc-a2"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#bc-ml)"
          d="M 505 133 L 685 133"
        />
        <!-- DB → PDS (vertical) -->
        <path
          id="bc-a3"
          class="ar"
          stroke="#7780DC"
          marker-end="url(#bc-ml)"
          d="M 762 183 L 762 320"
        />
        <!-- PDS → AppView (← left) -->
        <path
          id="bc-a4"
          class="ar"
          stroke="#24cf6e"
          marker-end="url(#bc-mg)"
          d="M 685 373 L 470 373"
        />
      </svg>

      <!-- Top row -->
      <div class="node" id="bc-nop" style="left: 20px; top: 80px; width: 150px">
        <div class="ni">👤</div>
        <div class="nn">Operator</div>
        <div class="ns">admin update</div>
      </div>

      <div
        class="node"
        id="bc-nst"
        style="left: 305px; top: 80px; width: 200px"
      >
        <div class="ni">⚙️</div>
        <div class="nn">Stratos Service</div>
        <div class="ns">update · re-sign</div>
      </div>

      <div
        class="node"
        id="bc-ndb"
        style="left: 685px; top: 80px; width: 155px"
      >
        <div class="ni">🛢️</div>
        <div class="nn">Service DB</div>
        <div class="ns">enrollment store</div>
      </div>

      <!-- Bottom row -->
      <div
        class="node"
        id="bc-npds"
        style="left: 685px; top: 320px; width: 155px"
      >
        <div class="ni">🗄️</div>
        <div class="nn">User PDS</div>
        <div class="ns">enrollment record</div>
      </div>

      <div
        class="node"
        id="bc-nav"
        style="left: 305px; top: 320px; width: 165px"
      >
        <div class="ni">📡</div>
        <div class="nn">AppView</div>
        <div class="ns">cache invalidated</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

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
  ;['bc-nop', 'bc-nst', 'bc-ndb', 'bc-npds', 'bc-nav'].forEach((id) =>
    rm($(id), 'hl', 'ok'),
  )
  ;['bc-a1', 'bc-a2', 'bc-a3', 'bc-a4'].forEach((id) => rm($(id), 'show'))
}

const steps = [
  {
    dur: 1600,
    fn() {
      add($('bc-nop'), 'hl')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('bc-nop'), 'hl')
      add($('bc-nst'), 'hl')
      add($('bc-a1'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('bc-nst'), 'hl')
      add($('bc-ndb'), 'hl')
      add($('bc-a2'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('bc-ndb'), 'hl')
      add($('bc-npds'), 'ok')
      add($('bc-a3'), 'show')
    },
  },
  {
    dur: 2200,
    fn() {
      add($('bc-nav'), 'ok')
      add($('bc-a4'), 'show')
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
@keyframes bc-breathe {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes bc-march {
  to {
    stroke-dashoffset: -12;
  }
}
.hl {
  border-color: var(--blu) !important;
  animation: bc-breathe 2s ease-in-out infinite;
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
  animation: bc-march 0.5s linear infinite;
}
</style>

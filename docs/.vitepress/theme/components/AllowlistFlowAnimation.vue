<template>
  <div class="anim-outer" ref="containerRef">
    <div class="stage" ref="stageRef">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="al-ml"
            markerWidth="7"
            markerHeight="5"
            refX="7"
            refY="2.5"
            orient="auto"
          >
            <polygon points="0 0,7 2.5,0 5" fill="#9145EC" />
          </marker>
          <marker
            id="al-mg"
            markerWidth="7"
            markerHeight="5"
            refX="7"
            refY="2.5"
            orient="auto"
          >
            <polygon points="0 0,7 2.5,0 5" fill="#24cf6e" />
          </marker>
        </defs>
        <!-- Client → Stratos -->
        <path
          id="al-a1"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#al-ml)"
          d="M 170 248 L 310 248"
        />
        <!-- Stratos → Eligibility -->
        <path
          id="al-a2"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#al-ml)"
          d="M 510 248 L 655 248"
        />
        <!-- Stratos → PDS (diagonal down) -->
        <path
          id="al-a3"
          class="ar"
          stroke="#24cf6e"
          marker-end="url(#al-mg)"
          d="M 407 298 L 387 375"
        />
      </svg>

      <!-- Left: User -->
      <div class="node" id="al-nc" style="left: 20px; top: 195px; width: 150px">
        <div class="ni">🧑</div>
        <div class="nn">User</div>
        <div class="ns">OAuth request</div>
      </div>

      <!-- Center: Stratos -->
      <div
        class="node"
        id="al-nst"
        style="left: 310px; top: 195px; width: 200px"
      >
        <div class="ni">⚙️</div>
        <div class="nn">Stratos Service</div>
        <div class="ns">enrollment</div>
      </div>

      <!-- Right: Eligibility Checks -->
      <div
        class="node"
        id="al-nel"
        style="left: 655px; top: 195px; width: 190px"
      >
        <div class="ni">✅</div>
        <div class="nn">Eligibility Check</div>
        <div class="ns">DID · PDS · external</div>
      </div>

      <!-- Bottom: PDS -->
      <div
        class="node"
        id="al-npds"
        style="left: 310px; top: 375px; width: 165px"
      >
        <div class="ni">🗄️</div>
        <div class="nn">User PDS</div>
        <div class="ns">enrollment record</div>
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
  ;['al-nc', 'al-nst', 'al-nel', 'al-npds'].forEach((id) =>
    rm($(id), 'hl', 'ok'),
  )
  ;['al-a1', 'al-a2', 'al-a3'].forEach((id) => rm($(id), 'show'))
}

const steps = [
  {
    dur: 1600,
    fn() {
      add($('al-nc'), 'hl')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('al-nc'), 'hl')
      add($('al-nst'), 'hl')
      add($('al-a1'), 'show')
    },
  },
  {
    dur: 2000,
    fn() {
      rm($('al-nst'), 'hl')
      add($('al-nel'), 'hl')
      add($('al-a2'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('al-nel'), 'hl')
      add($('al-nel'), 'ok')
      add($('al-a3'), 'show')
      add($('al-npds'), 'ok')
    },
  },
  {
    dur: 2000,
    fn() {
      add($('al-nc'), 'ok')
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
  width: 700px;
  height: 420px;
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
@keyframes al-breathe {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes al-march {
  to {
    stroke-dashoffset: -12;
  }
}
.hl {
  border-color: var(--blu) !important;
  animation: al-breathe 2s ease-in-out infinite;
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
  animation: al-march 0.5s linear infinite;
}
</style>

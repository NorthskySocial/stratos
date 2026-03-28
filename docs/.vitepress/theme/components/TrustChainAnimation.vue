<template>
  <div class="anim-outer" ref="containerRef">
    <div class="stage" ref="stageRef">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="tc-ml"
            markerWidth="7"
            markerHeight="5"
            refX="7"
            refY="2.5"
            orient="auto"
          >
            <polygon points="0 0,7 2.5,0 5" fill="#9145EC" />
          </marker>
          <marker
            id="tc-mg"
            markerWidth="7"
            markerHeight="5"
            refX="7"
            refY="2.5"
            orient="auto"
          >
            <polygon points="0 0,7 2.5,0 5" fill="#24cf6e" />
          </marker>
        </defs>
        <!-- Row 1: left → right -->
        <path
          id="tc-a1"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#tc-ml)"
          d="M 170 86 L 315 86"
        />
        <path
          id="tc-a2"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#tc-ml)"
          d="M 515 86 L 660 86"
        />
        <!-- Connector: PDS Record down to AppView -->
        <path
          id="tc-a3"
          class="ar"
          stroke="#7780DC"
          marker-end="url(#tc-ml)"
          d="M 747 138 L 742 340"
        />
        <!-- Row 2: right → left -->
        <path
          id="tc-a4"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#tc-ml)"
          d="M 660 391 L 510 391"
        />
        <path
          id="tc-a5"
          class="ar"
          stroke="#24cf6e"
          marker-end="url(#tc-mg)"
          d="M 340 391 L 180 391"
        />
      </svg>

      <!-- Row 1 -->
      <div class="node" id="tc-nk" style="left: 15px; top: 35px; width: 155px">
        <div class="ni">🔑</div>
        <div class="nn">Service Key</div>
        <div class="ns">secp256k1</div>
      </div>

      <div class="node" id="tc-ne" style="left: 315px; top: 35px; width: 200px">
        <div class="ni">✍️</div>
        <div class="nn">Attestation</div>
        <div class="ns">boundaries · did · signingKey</div>
      </div>

      <div class="node" id="tc-nr" style="left: 660px; top: 35px; width: 175px">
        <div class="ni">🗄️</div>
        <div class="nn">PDS Record</div>
        <div class="ns">enrollment record</div>
      </div>

      <!-- Row 2 (right → left) -->
      <div
        class="node"
        id="tc-na"
        style="left: 660px; top: 340px; width: 165px"
      >
        <div class="ni">📡</div>
        <div class="nn">AppView</div>
        <div class="ns">any verifier</div>
      </div>

      <div
        class="node"
        id="tc-nuk"
        style="left: 340px; top: 340px; width: 170px"
      >
        <div class="ni">🔐</div>
        <div class="nn">Signing Key</div>
        <div class="ns">P-256 per actor</div>
      </div>

      <div
        class="node"
        id="tc-nrc"
        style="left: 15px; top: 340px; width: 165px"
      >
        <div class="ni">📄</div>
        <div class="nn">Records</div>
        <div class="ns">individual posts</div>
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
  ;['tc-nk', 'tc-ne', 'tc-nr', 'tc-na', 'tc-nuk', 'tc-nrc'].forEach((id) =>
    rm($(id), 'hl', 'ok'),
  )
  ;['tc-a1', 'tc-a2', 'tc-a3', 'tc-a4', 'tc-a5'].forEach((id) =>
    rm($(id), 'show'),
  )
}

const steps = [
  {
    dur: 1600,
    fn() {
      add($('tc-nk'), 'hl')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('tc-nk'), 'hl')
      add($('tc-ne'), 'hl')
      add($('tc-a1'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('tc-ne'), 'hl')
      add($('tc-nr'), 'ok')
      add($('tc-a2'), 'show')
    },
  },
  {
    dur: 2000,
    fn() {
      add($('tc-na'), 'hl')
      add($('tc-a3'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('tc-na'), 'hl')
      add($('tc-nuk'), 'hl')
      add($('tc-a4'), 'show')
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('tc-nuk'), 'hl')
      add($('tc-nrc'), 'ok')
      add($('tc-a5'), 'show')
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
  --pur: #9145ec;
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

@keyframes tc-breathe {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes tc-march {
  to {
    stroke-dashoffset: -12;
  }
}

.hl {
  border-color: var(--blu) !important;
  animation: tc-breathe 2s ease-in-out infinite;
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
  animation: tc-march 0.5s linear infinite;
}
</style>

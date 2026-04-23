<template>
  <div ref="containerRef" class="anim-outer">
    <div ref="stageRef" class="stage">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="df-ml"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#9145EC" points="0 0,7 2.5,0 5" />
          </marker>
          <marker
            id="df-mg"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#24cf6e" points="0 0,7 2.5,0 5" />
          </marker>
        </defs>
        <!-- Row 1 horizontal -->
        <path
          id="df-a1"
          class="ar"
          d="M 165 86 L 310 86"
          marker-end="url(#df-ml)"
          stroke="#9145EC"
        />
        <path
          id="df-a2"
          class="ar"
          d="M 510 86 L 680 86"
          marker-end="url(#df-mg)"
          stroke="#24cf6e"
        />
        <!-- Row 1 → Row 2 diagonals -->
        <path
          id="df-a3"
          class="ar"
          d="M 410 138 L 450 215"
          marker-end="url(#df-ml)"
          stroke="#9145EC"
        />
        <path
          id="df-a4"
          class="ar"
          d="M 757 138 L 535 266"
          marker-end="url(#df-ml)"
          stroke="#9145EC"
        />
        <!-- Row 2 → Row 3 diagonal -->
        <path
          id="df-a5"
          class="ar"
          d="M 440 318 L 165 375"
          marker-end="url(#df-ml)"
          stroke="#9145EC"
        />
        <!-- Row 3 horizontal -->
        <path
          id="df-a6"
          class="ar"
          d="M 225 426 L 365 426"
          marker-end="url(#df-ml)"
          stroke="#9145EC"
        />
        <path
          id="df-a7"
          class="ar"
          d="M 535 426 L 685 426"
          marker-end="url(#df-mg)"
          stroke="#24cf6e"
        />
      </svg>

      <!-- Row 1 -->
      <div id="df-nu" class="node" style="left: 20px; top: 35px; width: 145px">
        <div class="ni">🧑</div>
        <div class="nn">User</div>
        <div class="ns">alice.bsky.social</div>
      </div>

      <div
        id="df-nst"
        class="node"
        style="left: 310px; top: 35px; width: 200px"
      >
        <div class="ni">⚙️</div>
        <div class="nn">Stratos Service</div>
        <div class="ns">stratos.example.com</div>
      </div>

      <div
        id="df-npds"
        class="node"
        style="left: 680px; top: 35px; width: 155px"
      >
        <div class="ni">🗄️</div>
        <div class="nn">PDS</div>
        <div class="ns">pds.bsky.social</div>
      </div>

      <!-- Row 2 -->
      <div
        id="df-nix"
        class="node"
        style="left: 365px; top: 215px; width: 170px"
      >
        <div class="ni">🔄</div>
        <div class="nn">Indexer</div>
        <div class="ns">stratos-indexer</div>
      </div>

      <!-- Row 3 -->
      <div
        id="df-ndb"
        class="node"
        style="left: 55px; top: 375px; width: 170px"
      >
        <div class="ni">🛢️</div>
        <div class="nn">PostgreSQL</div>
        <div class="ns">appview database</div>
      </div>

      <div
        id="df-nav"
        class="node"
        style="left: 365px; top: 375px; width: 170px"
      >
        <div class="ni">📡</div>
        <div class="nn">AppView</div>
        <div class="ns">zone.stratos.feed.*</div>
      </div>

      <div
        id="df-nc"
        class="node"
        style="left: 685px; top: 375px; width: 165px"
      >
        <div class="ni">💻</div>
        <div class="nn">Client App</div>
        <div class="ns">your application</div>
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
  ;[
    'df-nu',
    'df-nst',
    'df-npds',
    'df-nix',
    'df-ndb',
    'df-nav',
    'df-nc',
  ].forEach((id) => rm($(id), 'hl', 'ok'))
  ;['df-a1', 'df-a2', 'df-a3', 'df-a4', 'df-a5', 'df-a6', 'df-a7'].forEach(
    (id) => rm($(id), 'show'),
  )
}

const steps = [
  {
    dur: 1600,
    fn() {
      add($('df-nu'), 'hl')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('df-nu'), 'hl')
      add($('df-nst'), 'hl')
      add($('df-a1'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('df-nst'), 'hl')
      add($('df-npds'), 'ok')
      add($('df-a2'), 'show')
    },
  },
  {
    dur: 2000,
    fn() {
      add($('df-nix'), 'hl')
      add($('df-a3'), 'show')
      add($('df-a4'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('df-nix'), 'hl')
      add($('df-ndb'), 'hl')
      add($('df-a5'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('df-ndb'), 'hl')
      add($('df-nav'), 'hl')
      add($('df-a6'), 'show')
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('df-nav'), 'hl')
      add($('df-nc'), 'ok')
      add($('df-a7'), 'show')
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

@keyframes df-breathe {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes df-march {
  to {
    stroke-dashoffset: -12;
  }
}

.hl {
  border-color: var(--blu) !important;
  animation: df-breathe 2s ease-in-out infinite;
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
  animation: df-march 0.5s linear infinite;
}
</style>

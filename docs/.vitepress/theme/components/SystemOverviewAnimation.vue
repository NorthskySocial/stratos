<template>
  <div class="anim-outer" ref="containerRef">
    <div class="stage" ref="stageRef">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="so-ml"
            markerWidth="7"
            markerHeight="5"
            refX="7"
            refY="2.5"
            orient="auto"
          >
            <polygon points="0 0,7 2.5,0 5" fill="#9145EC" />
          </marker>
          <marker
            id="so-mg"
            markerWidth="7"
            markerHeight="5"
            refX="7"
            refY="2.5"
            orient="auto"
          >
            <polygon points="0 0,7 2.5,0 5" fill="#24cf6e" />
          </marker>
        </defs>
        <!-- PDS ↔ Stratos -->
        <path
          id="so-a1"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#so-ml)"
          d="M 170 248 L 325 248"
        />
        <!-- Stratos → AppView -->
        <path
          id="so-a2"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#so-ml)"
          d="M 530 248 L 690 248"
        />
        <!-- PDS → DID Resolver (upward) -->
        <path
          id="so-a3"
          class="ar"
          stroke="#7780DC"
          marker-end="url(#so-ml)"
          d="M 92 195 L 97 133"
        />
        <!-- Stratos → Blob Storage -->
        <path
          id="so-a4"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#so-ml)"
          d="M 430 298 L 355 375"
        />
        <!-- AppView → PostgreSQL -->
        <path
          id="so-a5"
          class="ar"
          stroke="#24cf6e"
          marker-end="url(#so-mg)"
          d="M 755 298 L 640 375"
        />
      </svg>

      <!-- Center row -->
      <div
        class="node"
        id="so-npds"
        style="left: 15px; top: 195px; width: 155px"
      >
        <div class="ni">🗄️</div>
        <div class="nn">User PDS</div>
        <div class="ns">pds.bsky.social</div>
      </div>

      <div
        class="node"
        id="so-nst"
        style="left: 325px; top: 195px; width: 205px"
      >
        <div class="ni">⚙️</div>
        <div class="nn">Stratos Service</div>
        <div class="ns">API · OAuth · repo</div>
      </div>

      <div
        class="node"
        id="so-nav"
        style="left: 690px; top: 195px; width: 165px"
      >
        <div class="ni">📡</div>
        <div class="nn">AppView</div>
        <div class="ns">zone.stratos.feed.*</div>
      </div>

      <!-- Top: DID Resolver (above PDS) -->
      <div
        class="node"
        id="so-ndid"
        style="left: 15px; top: 30px; width: 165px"
      >
        <div class="ni">🔍</div>
        <div class="nn">DID Resolver</div>
        <div class="ns">PLC · did:web</div>
      </div>

      <!-- Bottom row -->
      <div
        class="node"
        id="so-nblob"
        style="left: 240px; top: 375px; width: 175px"
      >
        <div class="ni">📦</div>
        <div class="nn">Blob Storage</div>
        <div class="ns">disk or S3</div>
      </div>

      <div
        class="node"
        id="so-ndb"
        style="left: 525px; top: 375px; width: 175px"
      >
        <div class="ni">🛢️</div>
        <div class="nn">PostgreSQL</div>
        <div class="ns">indexed records</div>
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
  ;['so-npds', 'so-nst', 'so-nav', 'so-ndid', 'so-nblob', 'so-ndb'].forEach(
    (id) => rm($(id), 'hl', 'ok'),
  )
  ;['so-a1', 'so-a2', 'so-a3', 'so-a4', 'so-a5'].forEach((id) =>
    rm($(id), 'show'),
  )
}

const steps = [
  {
    dur: 1500,
    fn() {
      add($('so-nst'), 'hl')
    },
  },
  {
    dur: 1800,
    fn() {
      add($('so-npds'), 'hl')
      add($('so-a1'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('so-npds'), 'hl')
      add($('so-ndid'), 'hl')
      add($('so-a3'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('so-ndid'), 'hl')
      rm($('so-nst'), 'hl')
      add($('so-nblob'), 'hl')
      add($('so-a4'), 'show')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('so-nblob'), 'hl')
      add($('so-nav'), 'hl')
      add($('so-a2'), 'show')
    },
  },
  {
    dur: 2000,
    fn() {
      rm($('so-nav'), 'hl')
      add($('so-ndb'), 'ok')
      add($('so-a5'), 'show')
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
@keyframes so-breathe {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes so-march {
  to {
    stroke-dashoffset: -12;
  }
}
.hl {
  border-color: var(--blu) !important;
  animation: so-breathe 2s ease-in-out infinite;
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
  animation: so-march 0.5s linear infinite;
}
</style>

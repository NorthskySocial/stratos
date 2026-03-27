<template>
  <div class="anim-outer" ref="containerRef">
    <div class="stage" ref="stageRef">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="ah-ml"
            markerWidth="7"
            markerHeight="5"
            refX="7"
            refY="2.5"
            orient="auto"
          >
            <polygon points="0 0,7 2.5,0 5" fill="#9145EC" />
          </marker>
          <marker
            id="ah-mg"
            markerWidth="7"
            markerHeight="5"
            refX="7"
            refY="2.5"
            orient="auto"
          >
            <polygon points="0 0,7 2.5,0 5" fill="#24cf6e" />
          </marker>
        </defs>
        <path
          id="ah-a1"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#ah-ml)"
          d="M 208 256 L 654 152"
        />
        <path
          id="ah-a2"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#ah-ml)"
          d="M 654 164 L 208 264"
        />
        <path
          id="ah-a3"
          class="ar"
          stroke="#9145EC"
          marker-end="url(#ah-ml)"
          d="M 208 266 L 654 370"
        />
        <path
          id="ah-a4"
          class="ar"
          stroke="#24cf6e"
          marker-end="url(#ah-mg)"
          d="M 654 382 L 208 272"
        />
      </svg>

      <div
        class="node"
        id="ah-nav"
        style="left: 38px; top: 215px; width: 170px"
      >
        <div class="ni">📱</div>
        <div class="nn">AppView</div>
        <div class="ns">appview.example.com</div>
        <div class="av-content" id="ah-av-record">full record ✓</div>
      </div>

      <div
        class="node"
        id="ah-npds"
        style="left: 654px; top: 100px; width: 190px"
      >
        <div class="ni">🗄️</div>
        <div class="nn">PDS</div>
        <div class="ns">pds.bsky.social</div>
        <div class="tag tb">has stub record</div>
      </div>

      <div
        class="node"
        id="ah-nst"
        style="left: 654px; top: 318px; width: 190px"
      >
        <div class="ni">⚙️</div>
        <div class="nn">Stratos Service</div>
        <div class="ns">stratos.example.com</div>
        <div class="tag tp">holds full records</div>
      </div>

      <div class="pill" id="ah-stub-pill" style="left: 330px; top: 152px">
        <div class="pill-row">
          <span class="icon">📋</span><span class="c-blu">stub record</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">→ </span
          ><span class="c-blu">stratos.example.com</span>
        </div>
      </div>

      <div class="pill" id="ah-auth-pill" style="left: 210px; top: 248px">
        <div class="pill-row">
          <span class="icon">🔐</span><span class="c-pur">DPoP token</span>
        </div>
        <div class="pill-row"><span class="c-dim">user auth</span></div>
      </div>

      <div
        class="pill"
        id="ah-proc-pill"
        style="left: 654px; top: 428px; width: 188px"
      >
        <div class="pill-row">
          <span class="icon">🔍</span><span class="c-pur">verifying auth</span>
        </div>
        <div class="pill-row">
          <span class="icon">⊓</span
          ><span class="c-pur">checking boundaries</span>
        </div>
      </div>

      <div class="pill" id="ah-rec-pill" style="left: 340px; top: 330px">
        <div class="pill-row">
          <span class="icon">📦</span><span class="c-grn">hydrated record</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">full content + metadata</span>
        </div>
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
  ;['ah-nav', 'ah-npds', 'ah-nst'].forEach((id) =>
    rm($(id), 'hl', 'ok', 'processing'),
  )
  ;['ah-a1', 'ah-a2', 'ah-a3', 'ah-a4'].forEach((id) => rm($(id), 'show'))
  ;['ah-stub-pill', 'ah-auth-pill', 'ah-proc-pill', 'ah-rec-pill'].forEach(
    (id) => rm($(id), 'show'),
  )
  rm($('ah-av-record'), 'show')
}

const steps = [
  {
    dur: 1900,
    fn() {
      add($('ah-nav'), 'hl')
      add($('ah-npds'), 'hl')
      add($('ah-a1'), 'show')
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('ah-nav'), 'hl')
      rm($('ah-npds'), 'hl')
      add($('ah-a2'), 'show')
      later(() => add($('ah-stub-pill'), 'show'), 250)
    },
  },
  {
    dur: 2000,
    fn() {
      rm($('ah-stub-pill'), 'show')
      add($('ah-nav'), 'hl')
      add($('ah-nst'), 'hl')
      add($('ah-auth-pill'), 'show')
      later(() => add($('ah-a3'), 'show'), 200)
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('ah-nav'), 'hl')
      rm($('ah-auth-pill'), 'show')
      rm($('ah-nst'), 'hl')
      add($('ah-nst'), 'processing')
      add($('ah-proc-pill'), 'show')
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('ah-nst'), 'processing')
      rm($('ah-proc-pill'), 'show')
      add($('ah-a4'), 'show')
      later(() => add($('ah-rec-pill'), 'show'), 250)
    },
  },
  {
    dur: 2000,
    fn() {
      rm($('ah-rec-pill'), 'show')
      add($('ah-nav'), 'ok')
      add($('ah-av-record'), 'show')
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
  border-radius: 0 0 12px 12px;
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
  width: 700px;
  height: 400px;
  background: radial-gradient(
    ellipse,
    rgba(80, 20, 130, 0.25) 0%,
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
    box-shadow 0.4s,
    opacity 0.4s,
    transform 0.4s;
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

.tag {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 99px;
  font-weight: 600;
  white-space: nowrap;
  margin-top: 3px;
}
.tb {
  background: rgba(145, 69, 236, 0.15);
  color: var(--blu);
  border: 1px solid rgba(145, 69, 236, 0.35);
}
.tp {
  background: rgba(145, 69, 236, 0.15);
  color: var(--pur);
  border: 1px solid rgba(145, 69, 236, 0.3);
}

.av-content {
  position: absolute;
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--dim);
  opacity: 0;
  transition: opacity 0.4s;
  white-space: nowrap;
}
.av-content.show {
  opacity: 1;
  color: var(--grn);
}

.pill {
  position: absolute;
  background: var(--card);
  border: 1px solid var(--bdr);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 11px;
  line-height: 1.6;
  opacity: 0;
  transform: scale(0.85);
  pointer-events: none;
  transition:
    opacity 0.4s,
    transform 0.4s;
}
.pill.show {
  opacity: 1;
  transform: scale(1);
}
.pill-row {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.pill-row .icon {
  font-size: 14px;
}

.c-blu {
  color: var(--blu);
}
.c-grn {
  color: var(--grn);
}
.c-pur {
  color: var(--pur);
}
.c-dim {
  color: var(--dim);
}

@keyframes ah-breathe {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes ah-process {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes ah-march {
  to {
    stroke-dashoffset: -12;
  }
}

.hl {
  border-color: var(--blu) !important;
  animation: ah-breathe 2s ease-in-out infinite;
}
.ok {
  border-color: var(--grn) !important;
  box-shadow: 0 0 24px rgba(36, 207, 110, 0.4) !important;
}
.processing {
  border-color: var(--pur) !important;
  animation: ah-process 1.2s ease-in-out infinite !important;
}
.gone {
  opacity: 0;
  transform: scale(0.88) translateY(6px);
  pointer-events: none;
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
  animation: ah-march 0.5s linear infinite;
}
</style>

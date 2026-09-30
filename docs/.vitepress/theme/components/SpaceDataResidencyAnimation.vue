<template>
  <div ref="containerRef" class="anim-outer">
    <div ref="stageRef" class="stage">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="sdr-ml"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#9145EC" points="0 0,7 2.5,0 5" />
          </marker>
          <marker
            id="sdr-mg"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#24cf6e" points="0 0,7 2.5,0 5" />
          </marker>
        </defs>
        <path
          id="sdr-a1"
          class="ar"
          d="M 208 252 L 360 252"
          marker-end="url(#sdr-ml)"
          stroke="#9145EC"
        />
        <path
          id="sdr-a2"
          class="ar"
          d="M 566 218 L 654 130"
          marker-end="url(#sdr-ml)"
          stroke="#9145EC"
        />
        <path
          id="sdr-a3"
          class="ar"
          d="M 566 286 L 654 396"
          marker-end="url(#sdr-mg)"
          stroke="#24cf6e"
        />
      </svg>

      <div
        id="sdr-nus"
        class="node"
        style="left: 38px; top: 208px; width: 170px"
      >
        <div class="ni">👤</div>
        <div class="nn">User</div>
        <div class="ns">did:plc:ewvi7n…</div>
      </div>

      <div
        id="sdr-nst"
        class="node"
        style="left: 360px; top: 190px; width: 206px"
      >
        <div class="ni">🏛️</div>
        <div class="nn">Stratos Service</div>
        <div class="ns">space authority</div>
        <div class="tag tp">full records, signed repo</div>
      </div>

      <div
        id="sdr-npds"
        class="node"
        style="left: 654px; top: 40px; width: 200px"
      >
        <div class="ni">🗄️</div>
        <div class="nn">User&#39;s PDS</div>
        <div class="ns">public network</div>
        <div class="tag tb">enrollment pointer only</div>
      </div>

      <div
        id="sdr-nh2"
        class="node"
        style="left: 654px; top: 360px; width: 200px"
      >
        <div class="ni">📦</div>
        <div class="nn">Second Host</div>
        <div class="ns">another Stratos / PDS</div>
        <div id="sdr-h2-ok" class="av-content">same CIDs, verified ✓</div>
      </div>

      <div id="sdr-write-pill" class="pill" style="left: 190px; top: 176px">
        <div class="pill-row">
          <span class="icon">✍️</span><span class="c-pur">createRecord</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">zone.stratos.feed.post</span>
        </div>
      </div>

      <div
        id="sdr-store-pill"
        class="pill"
        style="left: 360px; top: 312px; width: 206px"
      >
        <div class="pill-row">
          <span class="icon">🌳</span
          ><span class="c-pur">MST commit, IPLD blocks</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">signed with the user&#39;s key</span>
        </div>
      </div>

      <div id="sdr-ptr-pill" class="pill" style="left: 470px; top: 110px">
        <div class="pill-row">
          <span class="icon">📌</span
          ><span class="c-blu">enrollment record</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">no content on the firehose</span>
        </div>
      </div>

      <div id="sdr-car-pill" class="pill" style="left: 452px; top: 344px">
        <div class="pill-row">
          <span class="icon">🚚</span><span class="c-grn">repo.car</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">blocks + signed commit</span>
        </div>
      </div>

      <div
        id="sdr-vfy-pill"
        class="pill"
        style="left: 654px; top: 466px; width: 200px"
      >
        <div class="pill-row">
          <span class="icon">🔏</span
          ><span class="c-pur">verifying signatures</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">no trust in the old host</span>
        </div>
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
  ;['sdr-nus', 'sdr-nst', 'sdr-npds', 'sdr-nh2'].forEach((id) =>
    rm($(id), 'hl', 'ok', 'processing'),
  )
  ;['sdr-a1', 'sdr-a2', 'sdr-a3'].forEach((id) => rm($(id), 'show'))
  ;[
    'sdr-write-pill',
    'sdr-store-pill',
    'sdr-ptr-pill',
    'sdr-car-pill',
    'sdr-vfy-pill',
  ].forEach((id) => rm($(id), 'show'))
  rm($('sdr-h2-ok'), 'show')
}

const steps = [
  {
    dur: 2000,
    fn() {
      add($('sdr-nus'), 'hl')
      add($('sdr-nst'), 'hl')
      add($('sdr-a1'), 'show')
      later(() => add($('sdr-write-pill'), 'show'), 250)
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('sdr-write-pill'), 'show')
      rm($('sdr-nus'), 'hl')
      rm($('sdr-nst'), 'hl')
      add($('sdr-nst'), 'processing')
      add($('sdr-store-pill'), 'show')
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('sdr-nst'), 'processing')
      rm($('sdr-store-pill'), 'show')
      add($('sdr-npds'), 'hl')
      add($('sdr-a2'), 'show')
      later(() => add($('sdr-ptr-pill'), 'show'), 250)
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('sdr-npds'), 'hl')
      rm($('sdr-ptr-pill'), 'show')
      rm($('sdr-a2'), 'show')
      add($('sdr-nh2'), 'hl')
      add($('sdr-a3'), 'show')
      later(() => add($('sdr-car-pill'), 'show'), 250)
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('sdr-car-pill'), 'show')
      rm($('sdr-nh2'), 'hl')
      add($('sdr-nh2'), 'processing')
      add($('sdr-vfy-pill'), 'show')
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('sdr-nh2'), 'processing')
      rm($('sdr-vfy-pill'), 'show')
      add($('sdr-nh2'), 'ok')
      add($('sdr-h2-ok'), 'show')
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

@keyframes sdr-breathe {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes sdr-march {
  to {
    stroke-dashoffset: -12;
  }
}

.hl {
  border-color: var(--blu) !important;
  animation: sdr-breathe 2s ease-in-out infinite;
}
.ok {
  border-color: var(--grn) !important;
  box-shadow: 0 0 24px rgba(36, 207, 110, 0.4) !important;
}
.processing {
  border-color: var(--pur) !important;
  animation: sdr-breathe 1.2s ease-in-out infinite !important;
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
  animation: sdr-march 0.5s linear infinite;
}
</style>

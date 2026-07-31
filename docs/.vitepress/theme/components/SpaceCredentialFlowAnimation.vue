<template>
  <div ref="containerRef" class="anim-outer">
    <div ref="stageRef" class="stage">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="scf-ml"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#9145EC" points="0 0,7 2.5,0 5" />
          </marker>
          <marker
            id="scf-mg"
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
          id="scf-a1"
          class="ar"
          d="M 208 240 L 654 148"
          marker-end="url(#scf-ml)"
          stroke="#9145EC"
        />
        <path
          id="scf-a2"
          class="ar"
          d="M 654 160 L 208 250"
          marker-end="url(#scf-mg)"
          stroke="#24cf6e"
        />
        <path
          id="scf-a3"
          class="ar"
          d="M 208 262 L 654 370"
          marker-end="url(#scf-ml)"
          stroke="#9145EC"
        />
        <path
          id="scf-a4"
          class="ar"
          d="M 654 382 L 208 272"
          marker-end="url(#scf-mg)"
          stroke="#24cf6e"
        />
      </svg>

      <div
        id="scf-ncl"
        class="node"
        style="left: 38px; top: 210px; width: 170px"
      >
        <div class="ni">💻</div>
        <div class="nn">Client</div>
        <div class="ns">space member</div>
        <div id="scf-cl-record" class="av-content">record ✓</div>
      </div>

      <div
        id="scf-nau"
        class="node"
        style="left: 654px; top: 88px; width: 200px"
      >
        <div class="ni">🏛️</div>
        <div class="nn">Space Authority</div>
        <div class="ns">stratos.example.com</div>
        <div class="tag tp">mints credentials</div>
      </div>

      <div
        id="scf-nrh"
        class="node"
        style="left: 654px; top: 318px; width: 200px"
      >
        <div class="ni">🗄️</div>
        <div class="nn">Repo Host</div>
        <div class="ns">any host of the space</div>
        <div class="tag tb">serves records</div>
      </div>

      <div id="scf-req-pill" class="pill" style="left: 300px; top: 130px">
        <div class="pill-row">
          <span class="icon">🔐</span
          ><span class="c-pur">getSpaceCredential</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">at://…/space/…/engineering</span>
        </div>
      </div>

      <div
        id="scf-chk-pill"
        class="pill"
        style="left: 654px; top: 202px; width: 200px"
      >
        <div class="pill-row">
          <span class="icon">🔍</span
          ><span class="c-pur">checking enrollment</span>
        </div>
        <div class="pill-row">
          <span class="icon">📱</span><span class="c-pur">app allow-list</span>
        </div>
      </div>

      <div id="scf-cred-pill" class="pill" style="left: 310px; top: 196px">
        <div class="pill-row">
          <span class="icon">🎫</span
          ><span class="c-grn">space credential (JWT)</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">iss: authority · no aud · 2h</span>
        </div>
      </div>

      <div id="scf-read-pill" class="pill" style="left: 300px; top: 330px">
        <div class="pill-row">
          <span class="icon">📄</span><span class="c-pur">getRecord</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">Bearer: space credential</span>
        </div>
      </div>

      <div
        id="scf-vfy-pill"
        class="pill"
        style="left: 654px; top: 432px; width: 200px"
      >
        <div class="pill-row">
          <span class="icon">🔏</span
          ><span class="c-pur">verify via DID document</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">offline, no callback</span>
        </div>
      </div>

      <div id="scf-rec-pill" class="pill" style="left: 330px; top: 300px">
        <div class="pill-row">
          <span class="icon">📦</span><span class="c-grn">record</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">in-space only, no leak</span>
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
  ;['scf-ncl', 'scf-nau', 'scf-nrh'].forEach((id) =>
    rm($(id), 'hl', 'ok', 'processing'),
  )
  ;['scf-a1', 'scf-a2', 'scf-a3', 'scf-a4'].forEach((id) => rm($(id), 'show'))
  ;[
    'scf-req-pill',
    'scf-chk-pill',
    'scf-cred-pill',
    'scf-read-pill',
    'scf-vfy-pill',
    'scf-rec-pill',
  ].forEach((id) => rm($(id), 'show'))
  rm($('scf-cl-record'), 'show')
}

const steps = [
  {
    dur: 2000,
    fn() {
      add($('scf-ncl'), 'hl')
      add($('scf-nau'), 'hl')
      add($('scf-a1'), 'show')
      later(() => add($('scf-req-pill'), 'show'), 250)
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('scf-req-pill'), 'show')
      rm($('scf-ncl'), 'hl')
      rm($('scf-nau'), 'hl')
      add($('scf-nau'), 'processing')
      add($('scf-chk-pill'), 'show')
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('scf-nau'), 'processing')
      rm($('scf-chk-pill'), 'show')
      add($('scf-a2'), 'show')
      later(() => add($('scf-cred-pill'), 'show'), 250)
    },
  },
  {
    dur: 2000,
    fn() {
      rm($('scf-cred-pill'), 'show')
      add($('scf-ncl'), 'hl')
      add($('scf-nrh'), 'hl')
      add($('scf-a3'), 'show')
      later(() => add($('scf-read-pill'), 'show'), 250)
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('scf-read-pill'), 'show')
      rm($('scf-ncl'), 'hl')
      rm($('scf-nrh'), 'hl')
      add($('scf-nrh'), 'processing')
      add($('scf-vfy-pill'), 'show')
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('scf-nrh'), 'processing')
      rm($('scf-vfy-pill'), 'show')
      add($('scf-a4'), 'show')
      later(() => add($('scf-rec-pill'), 'show'), 250)
    },
  },
  {
    dur: 2000,
    fn() {
      rm($('scf-rec-pill'), 'show')
      add($('scf-ncl'), 'ok')
      add($('scf-cl-record'), 'show')
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

.c-grn {
  color: var(--grn);
}
.c-pur {
  color: var(--pur);
}
.c-dim {
  color: var(--dim);
}

@keyframes scf-breathe {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes scf-march {
  to {
    stroke-dashoffset: -12;
  }
}

.hl {
  border-color: var(--blu) !important;
  animation: scf-breathe 2s ease-in-out infinite;
}
.ok {
  border-color: var(--grn) !important;
  box-shadow: 0 0 24px rgba(36, 207, 110, 0.4) !important;
}
.processing {
  border-color: var(--pur) !important;
  animation: scf-breathe 1.2s ease-in-out infinite !important;
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
  animation: scf-march 0.5s linear infinite;
}
</style>

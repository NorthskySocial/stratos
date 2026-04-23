<template>
  <div ref="containerRef" class="anim-outer">
    <div ref="stageRef" class="stage">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="ba-ml"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#9145EC" points="0 0,7 2.5,0 5" />
          </marker>
          <marker
            id="ba-mg"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#24cf6e" points="0 0,7 2.5,0 5" />
          </marker>
          <marker
            id="ba-mr"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#f54b4b" points="0 0,7 2.5,0 5" />
          </marker>
        </defs>
        <path
          id="ba-avc"
          class="ar"
          d="M 218 200 L 312 338"
          marker-end="url(#ba-ml)"
          stroke="#9145EC"
        />
        <path
          id="ba-arc"
          class="ar"
          d="M 682 200 L 588 338"
          marker-end="url(#ba-ml)"
          stroke="#9145EC"
        />
        <path
          id="ba-acr"
          class="ar"
          d="M 450 385 L 450 412"
          marker-end="url(#ba-ml)"
          stroke="#9145EC"
        />
      </svg>

      <div id="ba-nv" class="node" style="left: 38px; top: 148px; width: 180px">
        <svg
          id="ba-smiley"
          fill="none"
          height="44"
          viewBox="0 0 38 38"
          width="44"
        >
          <circle cx="19" cy="19" r="16" stroke="#7780DC" stroke-width="2" />
          <circle cx="13.5" cy="15" fill="#7780DC" r="2" />
          <circle cx="24.5" cy="15" fill="#7780DC" r="2" />
          <path
            d="M 12.5 23 Q 19 29.5 25.5 23"
            fill="none"
            stroke="#7780DC"
            stroke-linecap="round"
            stroke-width="2"
          />
        </svg>
        <div class="nn">Viewer</div>
        <div class="ns">bob.bsky.social</div>
        <div class="tags">
          <span id="ba-vt1" class="tag tb">cooking</span>
        </div>
      </div>

      <div
        id="ba-nr"
        class="node"
        style="left: 682px; top: 148px; width: 190px"
      >
        <div class="ni">📄</div>
        <div class="nn">Record</div>
        <div class="ns">zone.stratos.feed.post</div>
        <div class="tags">
          <span id="ba-rt1" class="tag tb">cooking</span>
          <span id="ba-rt2" class="tag tb">hiking</span>
        </div>
      </div>

      <div
        id="ba-nchk"
        class="node gone"
        style="left: 312px; top: 295px; width: 276px; min-height: 90px"
      >
        <div style="display: flex; align-items: center; gap: 8px">
          <span style="font-size: 20px; color: #8878b0">⊓</span>
          <span id="ba-chk-label" class="nn">Boundary Intersection</span>
        </div>
        <div id="ba-chk-tags" class="tags"></div>
      </div>

      <div id="ba-res-box" class="result-box gone">
        <div id="ba-res-icon" class="res-icon">✓</div>
        <div id="ba-res-txt" class="res-txt">ACCESS GRANTED</div>
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

const SMILEY_DIM = '#7780DC'
const SMILEY_ACTIVE = '#9145EC'

function smileyColor(color) {
  stageRef.value
    ?.querySelectorAll('#ba-smiley circle, #ba-smiley path')
    .forEach((el) => {
      el.setAttribute('stroke', color)
      if (el.tagName === 'circle' && el.getAttribute('fill') !== 'none')
        el.setAttribute('fill', color)
    })
}

function setArrow(id, color, markerId) {
  const e = $(id)
  e?.setAttribute('stroke', color)
  e?.setAttribute('marker-end', `url(#${markerId})`)
}

function resetToPhaseA() {
  ;['ba-nv', 'ba-nr', 'ba-nchk'].forEach((id) => rm($(id), 'hl', 'ok', 'fail'))
  add($('ba-nchk'), 'gone')
  const rb = $('ba-res-box')
  add(rb, 'gone')
  rm(rb, 'ok', 'fail')
  ;['ba-avc', 'ba-arc', 'ba-acr'].forEach((id) => rm($(id), 'show'))
  setArrow('ba-avc', '#9145EC', 'ba-ml')
  setArrow('ba-arc', '#9145EC', 'ba-ml')
  setArrow('ba-acr', '#9145EC', 'ba-ml')
  const vt1 = $('ba-vt1')
  if (vt1) {
    vt1.textContent = 'cooking'
    vt1.className = 'tag tb'
  }
  const rt1 = $('ba-rt1')
  if (rt1) rt1.className = 'tag tb'
  const rt2 = $('ba-rt2')
  if (rt2) rt2.className = 'tag tb'
  const lbl = $('ba-chk-label')
  if (lbl) lbl.textContent = 'Boundary Intersection'
  const tags = $('ba-chk-tags')
  if (tags) tags.innerHTML = ''
  smileyColor(SMILEY_DIM)
}

const steps = [
  // Phase A: Access Granted
  {
    dur: 1800,
    fn() {
      add($('ba-nr'), 'hl')
    },
  },
  {
    dur: 1800,
    fn() {
      rm($('ba-nr'), 'hl')
      add($('ba-nv'), 'hl')
      smileyColor(SMILEY_ACTIVE)
    },
  },
  {
    dur: 1900,
    fn() {
      rm($('ba-nv'), 'hl')
      smileyColor(SMILEY_DIM)
      rm($('ba-nchk'), 'gone')
      add($('ba-nchk'), 'hl')
      add($('ba-avc'), 'show')
      add($('ba-arc'), 'show')
    },
  },
  {
    dur: 2000,
    fn() {
      const vt1 = $('ba-vt1')
      if (vt1) vt1.className = 'tag tg'
      const rt1 = $('ba-rt1')
      if (rt1) rt1.className = 'tag tg'
      const tags = $('ba-chk-tags')
      if (tags) tags.innerHTML = '<span class="tag tg">cooking</span>'
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('ba-nchk'), 'hl')
      add($('ba-nchk'), 'ok')
      add($('ba-acr'), 'show')
      const rb = $('ba-res-box')
      rm(rb, 'gone')
      add(rb, 'ok')
      const icon = $('ba-res-icon')
      if (icon) icon.textContent = '✓'
      const txt = $('ba-res-txt')
      if (txt) {
        txt.textContent = 'ACCESS GRANTED'
        txt.className = 'res-txt ok'
      }
    },
  },
  {
    dur: 700,
    fn() {
      resetToPhaseA()
    },
  },
  // Phase B: Access Denied
  {
    dur: 1800,
    fn() {
      add($('ba-nv'), 'hl')
      smileyColor(SMILEY_ACTIVE)
      const vt1 = $('ba-vt1')
      if (vt1) {
        vt1.textContent = 'gaming'
        vt1.className = 'tag to'
      }
    },
  },
  {
    dur: 1900,
    fn() {
      rm($('ba-nv'), 'hl')
      smileyColor(SMILEY_DIM)
      rm($('ba-nchk'), 'gone')
      add($('ba-nchk'), 'hl')
      setArrow('ba-avc', '#f54b4b', 'ba-mr')
      setArrow('ba-arc', '#f54b4b', 'ba-mr')
      setArrow('ba-acr', '#f54b4b', 'ba-mr')
      add($('ba-avc'), 'show')
      add($('ba-arc'), 'show')
    },
  },
  {
    dur: 2200,
    fn() {
      rm($('ba-nchk'), 'hl')
      add($('ba-nchk'), 'fail')
      const lbl = $('ba-chk-label')
      if (lbl) lbl.textContent = 'No shared boundaries'
      add($('ba-acr'), 'show')
      const rb = $('ba-res-box')
      rm(rb, 'gone')
      add(rb, 'fail')
      const icon = $('ba-res-icon')
      if (icon) icon.textContent = '✗'
      const txt = $('ba-res-txt')
      if (txt) {
        txt.textContent = 'ACCESS DENIED'
        txt.className = 'res-txt fail'
      }
    },
  },
]

function run(i) {
  steps[i].fn()
  later(() => {
    const next = (i + 1) % steps.length
    if (next === 0) {
      resetToPhaseA()
      later(() => run(0), 800)
    } else run(next)
  }, steps[i].dur)
}

let ro
onMounted(() => {
  ro = new ResizeObserver(fit)
  ro.observe(containerRef.value)
  fit()
  resetToPhaseA()
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
  --red: #f54b4b;
  --ora: #f5a523;
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

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  justify-content: center;
  margin-top: 4px;
}
.tag {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 99px;
  font-weight: 600;
  white-space: nowrap;
  transition:
    background 0.4s,
    color 0.4s,
    border-color 0.4s;
}
.tb {
  background: rgba(145, 69, 236, 0.15);
  color: var(--blu);
  border: 1px solid rgba(145, 69, 236, 0.35);
}
.tg {
  background: rgba(36, 207, 110, 0.18);
  color: var(--grn);
  border: 1px solid rgba(36, 207, 110, 0.35);
}
.tr {
  background: rgba(245, 75, 75, 0.15);
  color: var(--red);
  border: 1px solid rgba(245, 75, 75, 0.3);
}
.to {
  background: rgba(245, 165, 35, 0.15);
  color: var(--ora);
  border: 1px solid rgba(245, 165, 35, 0.3);
}

.result-box {
  position: absolute;
  left: 312px;
  top: 412px;
  width: 276px;
  height: 72px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1.5px solid var(--bdr);
  background: var(--card);
  transition:
    opacity 0.4s,
    transform 0.4s,
    border-color 0.4s,
    box-shadow 0.4s;
}
.result-box.gone {
  opacity: 0;
  transform: scale(0.9) translateY(6px);
  pointer-events: none;
}
.result-box.ok {
  background: rgba(36, 207, 110, 0.08);
  border-color: var(--grn);
  box-shadow: 0 0 22px rgba(36, 207, 110, 0.3);
}
.result-box.fail {
  background: rgba(245, 75, 75, 0.08);
  border-color: var(--red);
  box-shadow: 0 0 22px rgba(245, 75, 75, 0.3);
}

.res-icon {
  font-size: 28px;
}
.res-txt {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.07em;
}
.res-txt.ok {
  color: var(--grn);
}
.res-txt.fail {
  color: var(--red);
}

@keyframes ba-breathe {
  0%,
  100% {
    box-shadow: 0 0 22px rgba(145, 69, 236, 0.35);
  }
  50% {
    box-shadow: 0 0 42px rgba(145, 69, 236, 0.7);
  }
}
@keyframes ba-march {
  to {
    stroke-dashoffset: -12;
  }
}

.hl {
  border-color: var(--blu) !important;
  animation: ba-breathe 2s ease-in-out infinite;
}
.ok {
  border-color: var(--grn) !important;
  box-shadow: 0 0 24px rgba(36, 207, 110, 0.4) !important;
}
.fail {
  border-color: var(--red) !important;
  box-shadow: 0 0 24px rgba(245, 75, 75, 0.4) !important;
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
  animation: ba-march 0.5s linear infinite;
}
</style>

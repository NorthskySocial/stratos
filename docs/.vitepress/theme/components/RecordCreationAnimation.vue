<template>
  <div class="anim-outer" ref="containerRef">
    <div class="stage" ref="stageRef">

      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker id="rc-ml" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
            <polygon points="0 0,7 2.5,0 5" fill="#9145EC"/>
          </marker>
          <marker id="rc-mg" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
            <polygon points="0 0,7 2.5,0 5" fill="#24cf6e"/>
          </marker>
        </defs>
        <!-- Client → Stratos -->
        <path id="rc-a1" class="ar" stroke="#9145EC" marker-end="url(#rc-ml)" d="M 170 248 L 310 248"/>
        <!-- Stratos → Actor Store (up-right) -->
        <path id="rc-a2" class="ar" stroke="#9145EC" marker-end="url(#rc-ml)" d="M 510 222 L 650 128"/>
        <!-- Stratos → PDS (down-right) -->
        <path id="rc-a3" class="ar" stroke="#24cf6e" marker-end="url(#rc-mg)" d="M 510 272 L 650 360"/>
      </svg>

      <!-- Left: Client -->
      <div class="node" id="rc-nc" style="left:20px;top:195px;width:150px">
        <div class="ni">💻</div>
        <div class="nn">Client App</div>
        <div class="ns">createRecord</div>
      </div>

      <!-- Center: Stratos -->
      <div class="node" id="rc-nst" style="left:310px;top:195px;width:200px">
        <div class="ni">⚙️</div>
        <div class="nn">Stratos Service</div>
        <div class="ns">validate · sign · MST</div>
      </div>

      <!-- Top-right: Actor Store -->
      <div class="node" id="rc-nas" style="left:650px;top:50px;width:185px">
        <div class="ni">🗄️</div>
        <div class="nn">Actor Store</div>
        <div class="ns">IPLD blocks · index</div>
      </div>

      <!-- Bottom-right: PDS -->
      <div class="node" id="rc-npds" style="left:650px;top:335px;width:155px">
        <div class="ni">📌</div>
        <div class="nn">User PDS</div>
        <div class="ns">stub record</div>
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
const rm  = (el, ...c) => el?.classList.remove(...c)

function fit() {
  if (!containerRef.value || !stageRef.value) return
  const scale = containerRef.value.clientWidth / 900
  stageRef.value.style.transform = `scale(${scale})`
}

const timeouts = []
const later = (fn, ms) => { const t = setTimeout(fn, ms); timeouts.push(t); return t }

function reset() {
  ;['rc-nc','rc-nst','rc-nas','rc-npds'].forEach(id => rm($(id), 'hl', 'ok'))
  ;['rc-a1','rc-a2','rc-a3'].forEach(id => rm($(id), 'show'))
}

const steps = [
  { dur: 1600, fn() { add($('rc-nc'), 'hl') } },
  { dur: 1800, fn() { rm($('rc-nc'), 'hl'); add($('rc-nst'), 'hl'); add($('rc-a1'), 'show') } },
  { dur: 2000, fn() { rm($('rc-nst'), 'hl'); add($('rc-nas'), 'ok'); add($('rc-a2'), 'show') } },
  { dur: 2000, fn() { add($('rc-npds'), 'ok'); add($('rc-a3'), 'show') } },
]

function run(i) {
  steps[i].fn()
  later(() => {
    const next = (i + 1) % steps.length
    if (next === 0) { reset(); later(() => run(0), 800) }
    else run(next)
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
  background: #1F0B35;
  border-radius: 12px;
  margin: 1.5rem 0;
}
.stage {
  position: absolute; top: 0; left: 0;
  width: 900px; height: 520px;
  transform-origin: top left;
  --card: #240D45; --bdr: #7780DC; --txt: #cdc6ff; --dim: #8878b0;
  --blu: #9145EC; --grn: #24cf6e;
}
.stage::before {
  content: ''; position: absolute; top: 50%; left: 50%;
  transform: translate(-50%,-50%);
  width: 700px; height: 420px;
  background: radial-gradient(ellipse, rgba(80,20,130,.22) 0%, transparent 70%);
  pointer-events: none;
}
.node {
  position: absolute; background: var(--card); border: 1.5px solid var(--bdr);
  border-radius: 12px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 5px; padding: 12px 14px;
  transition: border-color .4s, box-shadow .4s;
}
.ni { font-size: 32px; line-height: 1; }
.nn { font-size: 15px; font-weight: 700; color: var(--txt); text-align: center; white-space: nowrap; }
.ns { font-size: 13px; color: var(--dim); text-align: center; white-space: nowrap; }
@keyframes rc-breathe {
  0%,100% { box-shadow: 0 0 22px rgba(145,69,236,.35); }
  50%      { box-shadow: 0 0 42px rgba(145,69,236,.7); }
}
@keyframes rc-march { to { stroke-dashoffset: -12; } }
.hl { border-color: var(--blu) !important; animation: rc-breathe 2s ease-in-out infinite; }
.ok { border-color: var(--grn) !important; box-shadow: 0 0 24px rgba(36,207,110,.4) !important; }
.arsvg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.ar { fill: none; stroke-width: 2; stroke-linecap: butt; stroke-dasharray: 8 4; opacity: 0; transition: opacity .4s; }
.ar.show { opacity: 1; animation: rc-march .5s linear infinite; }
</style>

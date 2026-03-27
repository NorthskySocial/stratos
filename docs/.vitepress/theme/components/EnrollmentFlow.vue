<template>
  <div class="anim-outer" ref="containerRef">
    <div class="stage" ref="stageRef">

      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker id="ef-ml" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
            <polygon points="0 0,7 2.5,0 5" fill="#9145EC"/>
          </marker>
          <marker id="ef-mg" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
            <polygon points="0 0,7 2.5,0 5" fill="#24cf6e"/>
          </marker>
        </defs>
        <path id="ef-a1" class="ar" stroke="#9145EC" marker-end="url(#ef-ml)" d="M 190 224 L 326 214"/>
        <path id="ef-a2" class="ar" stroke="#9145EC" marker-end="url(#ef-ml)" d="M 426 270 L 322 352"/>
        <path id="ef-a3" class="ar" stroke="#9145EC" marker-end="url(#ef-ml)" d="M 398 404 L 428 404"/>
        <path id="ef-a4" class="ar" stroke="#24cf6e" marker-end="url(#ef-mg)" d="M 526 214 L 716 224"/>
      </svg>

      <div class="node" id="ef-nu" style="left:40px;top:178px;width:155px">
        <div class="ni">🧑</div>
        <div class="nn">User</div>
        <div class="ns">alice.bsky.social</div>
      </div>

      <div class="node" id="ef-nst" style="left:326px;top:168px;width:200px">
        <div class="ni">⚙️</div>
        <div class="nn">Stratos Service</div>
        <div class="ns">stratos.example.com</div>
      </div>

      <div class="node" id="ef-npds" style="left:716px;top:178px;width:162px">
        <div class="ni">🗄️</div>
        <div class="nn">PDS</div>
        <div class="ns">pds.bsky.social</div>
      </div>

      <div class="node gone" id="ef-nkey" style="left:246px;top:352px;width:155px">
        <div class="ni">🔑</div>
        <div class="nn">Signing Key</div>
        <div class="badge">secp256k1</div>
      </div>

      <div class="node gone" id="ef-natt" style="left:428px;top:348px;width:204px">
        <div class="ni">✍️</div>
        <div class="nn">Attestation</div>
        <hr class="att-divider">
        <div class="att-fields">
          <div class="att-row"><span class="att-key">did</span><span class="att-val">alice.bsky.social</span></div>
          <div class="att-row"><span class="att-key">key</span><span class="att-val">secp256k1</span></div>
          <div class="att-row"><span class="att-key">sig</span><span class="att-val att-ok">✓ by service</span></div>
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
const rm  = (el, ...c) => el?.classList.remove(...c)

function fit() {
  if (!containerRef.value || !stageRef.value) return
  const scale = containerRef.value.clientWidth / 900
  stageRef.value.style.transform = `scale(${scale})`
}

const timeouts = []
const later = (fn, ms) => { const t = setTimeout(fn, ms); timeouts.push(t); return t }

function reset() {
  ;['ef-nu','ef-nst','ef-npds','ef-nkey','ef-natt'].forEach(id => rm($(id), 'hl', 'ok'))
  add($('ef-nkey'), 'gone')
  add($('ef-natt'), 'gone')
  ;['ef-a1','ef-a2','ef-a3','ef-a4'].forEach(id => rm($(id), 'show'))
}

const steps = [
  { dur: 1800, fn() { add($('ef-nu'), 'hl') } },
  { dur: 1900, fn() { rm($('ef-nu'), 'hl'); add($('ef-nst'), 'hl'); add($('ef-a1'), 'show') } },
  { dur: 1900, fn() { rm($('ef-nkey'), 'gone'); add($('ef-nkey'), 'hl'); add($('ef-a2'), 'show') } },
  { dur: 1900, fn() { rm($('ef-nkey'), 'hl'); rm($('ef-natt'), 'gone'); add($('ef-natt'), 'hl'); add($('ef-a3'), 'show') } },
  { dur: 2200, fn() { rm($('ef-natt'), 'hl'); rm($('ef-nst'), 'hl'); add($('ef-npds'), 'ok'); add($('ef-a4'), 'show') } },
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
  border-radius: 0 0 12px 12px;
}

.stage {
  position: absolute;
  top: 0;
  left: 0;
  width: 900px;
  height: 520px;
  transform-origin: top left;
  --card: #240D45;
  --bdr: #7780DC;
  --txt: #cdc6ff;
  --dim: #8878b0;
  --blu: #9145EC;
  --grn: #24cf6e;
  --pur: #9145EC;
}

.stage::before {
  content: '';
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%,-50%);
  width: 700px; height: 420px;
  background: radial-gradient(ellipse, rgba(80,20,130,.25) 0%, transparent 70%);
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
  transition: border-color .4s, box-shadow .4s, opacity .4s, transform .4s;
}

.ni { font-size: 32px; line-height: 1; }
.nn { font-size: 15px; font-weight: 700; color: var(--txt); text-align: center; white-space: nowrap; }
.ns { font-size: 13px; color: var(--dim); text-align: center; white-space: nowrap; }

.badge {
  font-size: 11px; padding: 3px 10px; border-radius: 99px; font-weight: 600;
  white-space: nowrap; margin-top: 2px;
  background: rgba(145,69,236,.15); color: var(--pur); border: 1px solid rgba(145,69,236,.3);
}

.att-divider { width: 100%; border: none; border-top: 1px solid rgba(119,128,220,0.3); margin: 2px 0; }
.att-fields { width: 100%; }
.att-row { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; gap: 8px; }
.att-key { color: var(--dim); font-weight: 600; flex-shrink: 0; }
.att-val { color: var(--txt); text-align: right; }
.att-ok { color: var(--grn); }

@keyframes ef-breathe {
  0%, 100% { box-shadow: 0 0 22px rgba(145,69,236,.35); }
  50% { box-shadow: 0 0 42px rgba(145,69,236,.7); }
}
@keyframes ef-march { to { stroke-dashoffset: -12; } }

.hl { border-color: var(--blu) !important; animation: ef-breathe 2s ease-in-out infinite; }
.ok { border-color: var(--grn) !important; box-shadow: 0 0 24px rgba(36,207,110,.4) !important; }
.gone { opacity: 0; transform: scale(.88) translateY(6px); pointer-events: none; }

.arsvg {
  position: absolute; top: 0; left: 0; width: 100%; height: 100%;
  pointer-events: none; overflow: visible;
}

.ar {
  fill: none; stroke-width: 2; stroke-linecap: butt;
  stroke-dasharray: 8 4; opacity: 0; transition: opacity .4s;
}
.ar.show { opacity: 1; animation: ef-march .5s linear infinite; }
</style>

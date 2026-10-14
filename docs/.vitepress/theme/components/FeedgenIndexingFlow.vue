<template>
  <div ref="containerRef" class="anim-outer">
    <div ref="stageRef" class="stage">
      <svg class="arsvg" viewBox="0 0 900 440">
        <defs>
          <marker
            id="fgi-ml"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#9145EC" points="0 0,7 2.5,0 5" />
          </marker>
          <marker
            id="fgi-mg"
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
          class="ar"
          d="M 238 196 L 370 116"
          marker-end="url(#fgi-ml)"
          stroke="#9145EC"
        />
        <path
          class="ar"
          d="M 480 156 L 480 288"
          marker-end="url(#fgi-ml)"
          stroke="#9145EC"
        />
        <path
          class="ar"
          d="M 238 252 L 370 332"
          marker-end="url(#fgi-ml)"
          stroke="#9145EC"
        />
        <path
          class="ar"
          d="M 590 336 L 680 244"
          marker-end="url(#fgi-mg)"
          stroke="#24cf6e"
        />
      </svg>

      <div class="node" style="left: 38px; top: 170px; width: 200px">
        <div class="ni">🏛️</div>
        <div class="nn">Stratos Service</div>
        <div class="ns">upstream sync streams</div>
      </div>

      <div class="node" style="left: 370px; top: 44px; width: 220px">
        <div class="ni">📇</div>
        <div class="nn">enrolled_actor</div>
        <div class="ns">who to follow</div>
        <div class="tag">from #enrollment events</div>
      </div>

      <div class="node" style="left: 370px; top: 288px; width: 220px">
        <div class="ni">⚙️</div>
        <div class="nn">Per-actor workers</div>
        <div class="ns">one stream per actor</div>
      </div>

      <div class="node" style="left: 680px; top: 152px; width: 185px">
        <div class="ni">🗃️</div>
        <div class="nn">Local index</div>
        <div class="ns">SQLite (WAL)</div>
        <div class="tag">post · post_boundary · cursor</div>
      </div>

      <div class="pill" style="left: 128px; top: 88px">
        <div class="pill-row">
          <span class="icon">📶</span
          ><span class="c-pur">service-level subscribeRecords</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">no did · replays #enrollment</span>
        </div>
      </div>

      <div class="pill" style="left: 500px; top: 196px">
        <div class="pill-row">
          <span class="icon">🔁</span
          ><span class="c-pur">starts / stops workers</span>
        </div>
      </div>

      <div class="pill" style="left: 96px; top: 330px">
        <div class="pill-row">
          <span class="icon">📶</span
          ><span class="c-pur">per-actor subscribeRecords</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">did + domain=&lt;boundary&gt;</span>
        </div>
      </div>

      <div class="pill" style="left: 596px; top: 366px">
        <div class="pill-row">
          <span class="icon">📦</span
          ><span class="c-grn">decoded commits → rows</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">cursors persisted for resume</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

const containerRef = ref(null)
const stageRef = ref(null)

function fit() {
  if (!containerRef.value || !stageRef.value) return
  const scale = containerRef.value.clientWidth / 900
  stageRef.value.style.transform = `scale(${scale})`
}

let ro
onMounted(() => {
  ro = new ResizeObserver(fit)
  ro.observe(containerRef.value)
  fit()
})
onBeforeUnmount(() => {
  ro?.disconnect()
})
</script>

<style scoped>
.anim-outer {
  width: 100%;
  aspect-ratio: 900 / 440;
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
  height: 440px;
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
  height: 340px;
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
  font-size: 12px;
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
  background: rgba(145, 69, 236, 0.15);
  color: var(--blu);
  border: 1px solid rgba(145, 69, 236, 0.35);
}

.pill {
  position: absolute;
  background: var(--card);
  border: 1px solid var(--bdr);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 11px;
  line-height: 1.6;
  pointer-events: none;
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

@keyframes fgi-march {
  to {
    stroke-dashoffset: -12;
  }
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
  animation: fgi-march 0.5s linear infinite;
}
</style>

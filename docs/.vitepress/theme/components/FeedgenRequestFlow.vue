<template>
  <div ref="containerRef" class="anim-outer">
    <div ref="stageRef" class="stage">
      <svg class="arsvg" viewBox="0 0 900 520">
        <defs>
          <marker
            id="fgr-ml"
            markerHeight="5"
            markerWidth="7"
            orient="auto"
            refX="7"
            refY="2.5"
          >
            <polygon fill="#9145EC" points="0 0,7 2.5,0 5" />
          </marker>
          <marker
            id="fgr-mg"
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
          d="M 208 240 L 330 240"
          marker-end="url(#fgr-ml)"
          stroke="#9145EC"
        />
        <path
          class="ar"
          d="M 520 218 L 640 120"
          marker-end="url(#fgr-ml)"
          stroke="#9145EC"
        />
        <path
          class="ar"
          d="M 750 396 L 750 424"
          marker-end="url(#fgr-ml)"
          stroke="#9145EC"
        />
        <path
          class="ar"
          d="M 640 300 L 208 262"
          marker-end="url(#fgr-mg)"
          stroke="#24cf6e"
        />
      </svg>

      <div class="node" style="left: 38px; top: 204px; width: 170px">
        <div class="ni">💻</div>
        <div class="nn">Client</div>
        <div class="ns">boundary member</div>
      </div>

      <div class="node" style="left: 330px; top: 196px; width: 190px">
        <div class="ni">🗄️</div>
        <div class="nn">User&#39;s PDS</div>
        <div class="ns">OAuth + DPoP</div>
        <div class="tag tb">atproto-proxy</div>
      </div>

      <div class="node" style="left: 640px; top: 36px; width: 220px">
        <div class="ni">📡</div>
        <div class="nn">Feed Generator</div>
        <div class="ns">did:web…#stratos_feedgen</div>
      </div>

      <div class="panel" style="left: 640px; top: 168px; width: 220px">
        <div class="prow">
          <span class="icon">🔏</span>
          <span class="c-txt">verify service JWT<br /><span class="c-dim">against the user&#39;s DID doc</span></span>
        </div>
        <div class="prow">
          <span class="icon">🧭</span>
          <span class="c-txt">viewer boundaries<br /><span class="c-dim">TTL + LRU cache</span></span>
        </div>
        <div class="prow">
          <span class="icon">🗃️</span>
          <span class="c-txt">query local post index</span>
        </div>
        <div class="prow">
          <span class="icon">💧</span>
          <span class="c-txt">hydrate index misses</span>
        </div>
        <div class="prow">
          <span class="icon">🖼️</span>
          <span class="c-txt">blobs from S3 cache</span>
        </div>
      </div>

      <div class="node" style="left: 640px; top: 424px; width: 220px">
        <div class="ni">🏛️</div>
        <div class="nn">Upstream Stratos</div>
        <div class="ns">resolveEnrollments · hydrateRecords · getBlob</div>
      </div>

      <div class="pill" style="left: 218px; top: 158px">
        <div class="pill-row">
          <span class="icon">📄</span><span class="c-pur">getFeed</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">zone.stratos.feedgen.getFeed</span>
        </div>
      </div>

      <div class="pill" style="left: 470px; top: 100px">
        <div class="pill-row">
          <span class="icon">🎫</span><span class="c-pur">service JWT</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">iss = user DID · exp &lt; 60s</span>
        </div>
      </div>

      <div class="pill" style="left: 430px; top: 400px">
        <div class="pill-row">
          <span class="icon">🎫</span><span class="c-pur">on cache miss</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">service JWT · iss = feedgen DID</span>
        </div>
      </div>

      <div class="pill" style="left: 300px; top: 300px">
        <div class="pill-row">
          <span class="icon">📦</span><span class="c-grn">hydrated feed</span>
        </div>
        <div class="pill-row">
          <span class="c-dim">boundary-filtered, labels attached</span>
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
.tb {
  background: rgba(145, 69, 236, 0.15);
}

.panel {
  position: absolute;
  background: var(--card);
  border: 1.5px solid var(--bdr);
  border-radius: 12px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.prow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  line-height: 1.4;
}
.prow .icon {
  font-size: 14px;
}
.c-txt {
  color: var(--txt);
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

@keyframes fgr-march {
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
  animation: fgr-march 0.5s linear infinite;
}
</style>

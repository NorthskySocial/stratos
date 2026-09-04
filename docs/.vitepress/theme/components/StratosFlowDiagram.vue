<template>
  <figure class="stratos-diagram">
    <svg
      viewBox="0 0 520 430"
      role="img"
      aria-labelledby="stratos-flow-title stratos-flow-description"
    >
      <title id="stratos-flow-title">Stratos-custody record delivery</title>
      <desc id="stratos-flow-description">
        Four stages show the standard Stratos-custody path: enrollment metadata
        on the PDS, private record storage in Stratos, an authorized projection,
        and a hydrated client view.
      </desc>
      <!-- Place four stages on the center line with equal vertical spacing. -->
      <defs>
        <marker
          id="stratos-flow-arrow"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
        </marker>
      </defs>

      <g class="links" fill="none" marker-end="url(#stratos-flow-arrow)">
        <path d="M 260 96 V 124" />
        <path d="M 260 184 V 212" />
        <path d="M 260 272 V 300" />
      </g>

      <g class="step pds" transform="translate(78 32)">
        <rect width="364" height="64" rx="12" />
        <image href="/icons/link.svg" x="22" y="20" width="24" height="24" />
        <text x="68" y="30">PDS enrollment record</text>
        <text class="detail" x="68" y="49">
          Public service discovery and enrollment attestation
        </text>
      </g>
      <text class="arrow-label" x="278" y="114">route</text>

      <g class="step service" transform="translate(78 124)">
        <rect width="364" height="64" rx="12" />
        <image href="/icons/lock.svg" x="22" y="20" width="24" height="24" />
        <text x="68" y="30">Stratos-custody actor repository</text>
        <text class="detail" x="68" y="49">
          Private records, CIDs, signed commits, and boundary checks
        </text>
      </g>
      <text class="arrow-label" x="278" y="206">subscribe</text>

      <g class="step projection" transform="translate(78 216)">
        <rect width="364" height="64" rx="12" />
        <image href="/icons/cloud.svg" x="22" y="20" width="24" height="24" />
        <text x="68" y="30">Authorized projection</text>
        <text class="detail" x="68" y="49">
          Feed generator or AppView consumes approved Stratos data
        </text>
      </g>
      <text class="arrow-label" x="278" y="298">serve</text>

      <g class="step client" transform="translate(78 308)">
        <rect width="364" height="64" rx="12" />
        <image href="/icons/link.svg" x="22" y="20" width="24" height="24" />
        <text x="68" y="30">Hydrated client view</text>
        <text class="detail" x="68" y="49">
          Content returns only after current access is verified
        </text>
      </g>
    </svg>
    <figcaption>
      In the standard Stratos-custody path, private records stay in Stratos. A
      spaces-capable PDS uses the separate member-hosted path shown above.
    </figcaption>
  </figure>
</template>

<style scoped>
.stratos-diagram {
  padding: 1rem;
}
svg {
  color: #7780dc;
}
.links {
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}
.step rect {
  fill: #fff;
  stroke: #c5c9ef;
  stroke-width: 1.5;
}
.step text {
  fill: #172235;
  font-size: 15px;
  font-weight: 700;
}
.step .detail,
.arrow-label {
  fill: #526174;
  font-size: 11px;
  font-weight: 500;
}
.arrow-label {
  fill: #7780dc;
  font-weight: 700;
}
.service rect {
  fill: #eef0ff;
  stroke: #7780dc;
}
.projection rect {
  fill: #e8faf5;
  stroke: #40dac4;
}
.client rect {
  fill: #eef8fb;
  stroke: #59b2cf;
}
figcaption {
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.5;
  padding: 0.5rem 0.75rem 0.25rem;
}
.dark .step rect {
  fill: #172235;
  stroke: #61749a;
}
.dark .service rect {
  fill: #29275d;
  stroke: #9ca4ef;
}
.dark .projection rect {
  fill: #163e42;
  stroke: #61d1c2;
}
.dark .client rect {
  fill: #173b48;
  stroke: #72c6df;
}
.dark .step text {
  fill: #eef4ff;
}
.dark .step .detail {
  fill: #b7c4dc;
}
</style>

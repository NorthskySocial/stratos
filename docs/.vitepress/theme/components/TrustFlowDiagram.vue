<template>
  <figure class="stratos-diagram">
    <svg
      viewBox="0 0 520 330"
      role="img"
      aria-labelledby="trust-flow-title trust-flow-description"
    >
      <title id="trust-flow-title">
        Enrollment verification and authorization
      </title>
      <desc id="trust-flow-description">
        The PDS enrollment record supports discovery, the service attestation
        supports verification, and Stratos performs the live access check.
      </desc>
      <!-- Place three verification stages on the center line with equal spacing. -->
      <defs>
        <marker
          id="trust-flow-arrow"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
        </marker>
      </defs>
      <g class="links" fill="none" marker-end="url(#trust-flow-arrow)">
        <path d="M 260 92 V 122" />
        <path d="M 260 182 V 212" />
      </g>
      <g class="step" transform="translate(78 28)">
        <rect width="364" height="64" rx="12" />
        <image href="/icons/link.svg" x="22" y="20" width="24" height="24" />
        <text x="68" y="30">Enrollment record on the PDS</text>
        <text class="detail" x="68" y="49">
          Find the service and the enrolled user signing key
        </text>
      </g>
      <g class="step attestation" transform="translate(78 122)">
        <rect width="364" height="64" rx="12" />
        <image href="/icons/lock.svg" x="22" y="20" width="24" height="24" />
        <text x="68" y="30">Service attestation</text>
        <text class="detail" x="68" y="49">
          Verify the DID, boundary set, and signing-key statement
        </text>
      </g>
      <g class="step live" transform="translate(78 216)">
        <rect width="364" height="64" rx="12" />
        <image href="/icons/cloud.svg" x="22" y="20" width="24" height="24" />
        <text x="68" y="30">Live Stratos access check</text>
        <text class="detail" x="68" y="49">
          Require current shared-boundary membership before delivery
        </text>
      </g>
    </svg>
    <figcaption>
      Discovery and attestation verify an enrollment statement. The live service
      check decides whether a private read is allowed now.
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
.step .detail {
  fill: #526174;
  font-size: 11px;
  font-weight: 500;
}
.attestation rect {
  fill: #eef0ff;
  stroke: #7780dc;
}
.live rect {
  fill: #e8faf5;
  stroke: #40dac4;
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
.dark .attestation rect {
  fill: #29275d;
  stroke: #9ca4ef;
}
.dark .live rect {
  fill: #163e42;
  stroke: #61d1c2;
}
.dark .step text {
  fill: #eef4ff;
}
.dark .step .detail {
  fill: #b7c4dc;
}
</style>

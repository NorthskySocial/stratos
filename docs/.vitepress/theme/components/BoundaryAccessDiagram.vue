<template>
  <figure class="boundary-diagram">
    <svg
      viewBox="0 0 600 350"
      role="img"
      aria-labelledby="boundary-access-title boundary-access-description"
    >
      <title id="boundary-access-title">Boundary access evaluation</title>
      <desc id="boundary-access-description">
        Stratos compares the viewer's current boundary memberships with a
        private record's boundary values. A shared value permits delivery. No
        shared value returns not found.
      </desc>
      <defs>
        <marker
          id="boundary-access-arrow"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
        </marker>
      </defs>

      <g class="links" fill="none" marker-end="url(#boundary-access-arrow)">
        <path d="M 152 124 L 236 170" />
        <path d="M 448 124 L 364 170" />
        <path d="M 300 234 V 262" />
      </g>

      <g class="card viewer" transform="translate(42 30)">
        <rect width="220" height="94" rx="12" />
        <text x="18" y="29">Viewer memberships</text>
        <text class="detail" x="18" y="51">engineering</text>
        <text class="detail" x="18" y="72">writers</text>
      </g>

      <g class="card record" transform="translate(338 30)">
        <rect width="220" height="94" rx="12" />
        <text x="18" y="29">Private record boundaries</text>
        <text class="detail" x="18" y="51">engineering</text>
        <text class="detail" x="18" y="72">leadership</text>
      </g>

      <g class="card check" transform="translate(130 170)">
        <rect width="340" height="64" rx="12" />
        <text x="170" y="29" text-anchor="middle">
          Stratos live boundary check
        </text>
        <text class="detail" x="170" y="49" text-anchor="middle">
          Compare current membership with record values
        </text>
      </g>

      <g class="result" transform="translate(130 262)">
        <rect width="340" height="44" rx="10" />
        <text x="170" y="28" text-anchor="middle">
          Shared boundary: engineering · deliver record
        </text>
      </g>
      <text class="denied" x="300" y="334" text-anchor="middle">
        No shared boundary: do not deliver content
      </text>
    </svg>
    <figcaption>
      The service makes this decision at read time. Client-side filtering does
      not grant access.
    </figcaption>
  </figure>
</template>

<style scoped>
.boundary-diagram {
  padding: 1rem;
}
svg {
  color: #7780dc;
}
.links {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 2;
}
.card rect {
  fill: #fff;
  stroke: #c5c9ef;
  stroke-width: 1.5;
}
.card text {
  fill: #172235;
  font-size: 15px;
  font-weight: 700;
}
.card .detail {
  fill: #526174;
  font-size: 13px;
  font-weight: 500;
}
.viewer rect {
  fill: #eef8fb;
  stroke: #59b2cf;
}
.record rect {
  fill: #eef0ff;
  stroke: #7780dc;
}
.check rect {
  fill: #e8faf5;
  stroke: #40dac4;
}
.result rect {
  fill: #e8faf5;
  stroke: #40dac4;
  stroke-width: 1.5;
}
.result text {
  fill: #176c5c;
  font-size: 14px;
  font-weight: 700;
}
.denied {
  fill: #8a4b51;
  font-size: 13px;
  font-weight: 600;
}
figcaption {
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.5;
  padding: 0.5rem 0.75rem 0.25rem;
}
.dark .card rect {
  fill: #172235;
  stroke: #61749a;
}
.dark .viewer rect {
  fill: #173b48;
  stroke: #72c6df;
}
.dark .record rect {
  fill: #29275d;
  stroke: #9ca4ef;
}
.dark .check rect,
.dark .result rect {
  fill: #163e42;
  stroke: #61d1c2;
}
.dark .card text {
  fill: #eef4ff;
}
.dark .card .detail {
  fill: #b7c4dc;
}
.dark .result text {
  fill: #80e4d2;
}
.dark .denied {
  fill: #f3adb3;
}
</style>

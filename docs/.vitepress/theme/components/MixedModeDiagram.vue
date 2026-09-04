<template>
  <figure class="mixed-mode-diagram">
    <svg
      viewBox="0 0 900 560"
      role="img"
      aria-labelledby="mixed-mode-title mixed-mode-description"
    >
      <!--
        Coordinate plan (900 × 560): shared authority 282–618 × 32–104;
        non-spaces lane 46–296 × 136–456; spaces lane 604–854 × 136–456;
        both repository connectors converge at Feedgen 282–618 × 435–521.
        Packets begin on each inbound path, with a 32-unit clear page margin.
      -->
      <title id="mixed-mode-title">Mixed-mode custody flow</title>
      <desc id="mixed-mode-description">
        Stratos is the membership authority in both modes. In the non-spaces
        path Stratos hosts and signs the actor repository, which Feedgen
        receives over a subscription. In the spaces path the member PDS hosts
        and signs a space repository, which Feedgen pulls after Stratos has
        supplied the member list and a space credential. Both paths converge in
        the same boundary-scoped feed projection.
      </desc>
      <defs>
        <marker
          id="mixed-mode-arrow"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
        </marker>
      </defs>

      <g
        class="authority-links"
        fill="none"
        marker-end="url(#mixed-mode-arrow)"
      >
        <path d="M 300 104 C 230 126 180 142 171 170" />
        <path d="M 600 104 C 670 126 720 142 729 170" />
        <path d="M 450 104 V 346" />
      </g>
      <g
        class="flow-line standard-flow"
        fill="none"
        marker-end="url(#mixed-mode-arrow)"
      >
        <path d="M 171 250 V 299" />
        <path d="M 171 371 C 221 401 298 417 358 435" />
      </g>
      <g
        class="flow-line spaces-flow"
        fill="none"
        marker-end="url(#mixed-mode-arrow)"
      >
        <path d="M 729 250 V 299" />
        <path d="M 729 371 C 679 401 602 417 542 435" />
      </g>

      <g class="card authority" transform="translate(282 32)">
        <rect width="336" height="72" rx="14" />
        <text x="168" y="29" text-anchor="middle">
          Stratos: the shared authority
        </text>
        <text class="detail" x="168" y="51" text-anchor="middle">
          enrollment, membership, boundary ↔ space mapping
        </text>
      </g>

      <g class="lane standard-lane" transform="translate(46 136)">
        <rect width="250" height="320" rx="18" />
      </g>
      <g class="lane spaces-lane" transform="translate(604 136)">
        <rect width="250" height="320" rx="18" />
      </g>
      <text
        class="lane-title standard-title"
        x="171"
        y="159"
        text-anchor="middle"
      >
        Non-spaces mode
      </text>
      <text
        class="lane-title spaces-title"
        x="729"
        y="159"
        text-anchor="middle"
      >
        Spaces mode
      </text>

      <g class="card custody standard" transform="translate(70 170)">
        <rect width="202" height="80" rx="12" />
        <text x="101" y="29" text-anchor="middle">custody: stratos</text>
        <text class="detail" x="101" y="51" text-anchor="middle">
          PDS has no spaces support
        </text>
        <text class="detail" x="101" y="69" text-anchor="middle">
          standard repo URI
        </text>
      </g>
      <g class="card repository standard" transform="translate(70 299)">
        <rect width="202" height="72" rx="12" />
        <text x="101" y="28" text-anchor="middle">Stratos actor repo</text>
        <text class="detail" x="101" y="48" text-anchor="middle">
          Stratos writes and signs
        </text>
        <text class="detail" x="101" y="65" text-anchor="middle">
          subscribeRecords
        </text>
      </g>

      <g class="card custody spaces" transform="translate(628 170)">
        <rect width="202" height="80" rx="12" />
        <text x="101" y="29" text-anchor="middle">custody: pds</text>
        <text class="detail" x="101" y="51" text-anchor="middle">
          PDS supports spaces
        </text>
        <text class="detail" x="101" y="69" text-anchor="middle">
          space record URI
        </text>
      </g>
      <g class="card repository spaces" transform="translate(628 299)">
        <rect width="202" height="72" rx="12" />
        <text x="101" y="28" text-anchor="middle">Member PDS space repo</text>
        <text class="detail" x="101" y="48" text-anchor="middle">
          member writes and signs
        </text>
        <text class="detail" x="101" y="65" text-anchor="middle">
          listRepoOps + DPoP proof
        </text>
      </g>

      <text class="flow-label standard-label" x="80" y="399">subscribe</text>
      <text class="flow-label spaces-label" x="633" y="399">
        pull after listRepos + credential
      </text>
      <text class="authority-label" x="465" y="243">
        custody, current members, credential
      </text>

      <g class="card feedgen" transform="translate(282 435)">
        <rect width="336" height="86" rx="14" />
        <text x="168" y="31" text-anchor="middle">One Feedgen projection</text>
        <text class="detail" x="168" y="53" text-anchor="middle">
          assign the authority's boundary on both paths
        </text>
        <text class="detail" x="168" y="74" text-anchor="middle">
          verify space commits before promotion
        </text>
      </g>
      <g
        id="standard-handoff-packet"
        class="packet standard-packet standard-handoff-packet"
      >
        <circle cx="171" cy="265" r="5" />
      </g>
      <g
        id="standard-sync-packet"
        class="packet standard-packet standard-sync-packet"
      >
        <circle cx="184" cy="379" r="5" />
      </g>
      <g
        id="spaces-handoff-packet"
        class="packet spaces-packet spaces-handoff-packet"
      >
        <circle cx="729" cy="265" r="5" />
      </g>
      <g
        id="spaces-sync-packet"
        class="packet spaces-packet spaces-sync-packet"
      >
        <circle cx="716" cy="379" r="5" />
      </g>
      <g id="authority-custody-packet" class="packet authority-packet">
        <circle cx="450" cy="119" r="5" />
      </g>
      <text class="footnote" x="450" y="548" text-anchor="middle">
        Custody changes the write and ingestion path, never the authority that
        defines membership.
      </text>
    </svg>
    <figcaption>
      The mixed-mode layer joins established PDSs and space-aware PDSs without
      treating a record's claimed boundary as permission. On the spaces path,
      Feedgen derives the boundary from the trusted poll target instead.
    </figcaption>
  </figure>
</template>

<style scoped>
.mixed-mode-diagram {
  margin: 1.75rem 0;
}

svg {
  display: block;
  height: auto;
  max-width: 100%;
  overflow: visible;
}

.authority-links,
.flow-line {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 2.25;
}

.authority-links {
  color: #697997;
  stroke-dasharray: 5 6;
}

.standard-flow {
  color: #6458a7;
}

.spaces-flow {
  color: #1e9e8b;
}

.packet {
  fill: currentColor;
  opacity: 0;
  transform-box: fill-box;
  transform-origin: center;
  vector-effect: non-scaling-stroke;
}

.standard-packet {
  color: #6458a7;
}

.spaces-packet {
  color: #1e9e8b;
}

.authority-packet {
  color: #697997;
}

@media (prefers-reduced-motion: no-preference) {
  .standard-handoff-packet {
    animation: handoff-packet 2.8s cubic-bezier(0.65, 0, 0.35, 1) infinite;
  }

  .standard-sync-packet {
    animation: standard-sync-packet 2.8s cubic-bezier(0.65, 0, 0.35, 1) 0.3s
      infinite;
  }

  .spaces-handoff-packet {
    animation: handoff-packet 2.8s cubic-bezier(0.65, 0, 0.35, 1) 0.5s infinite;
  }

  .spaces-sync-packet {
    animation: spaces-sync-packet 2.8s cubic-bezier(0.65, 0, 0.35, 1) 0.8s
      infinite;
  }

  .authority-packet {
    animation: authority-packet 2.8s cubic-bezier(0.65, 0, 0.35, 1) 0.9s
      infinite;
  }
}

.lane rect {
  fill: #fafaff;
  stroke: #d9dded;
  stroke-width: 1.25;
}

.spaces-lane rect {
  fill: #f7fdfb;
  stroke: #b8e1d8;
}

.card rect {
  fill: #fff;
  stroke: #c6cce0;
  stroke-width: 1.5;
}

.card text {
  fill: #172235;
  font-size: 15px;
  font-weight: 700;
}

.card .detail {
  fill: #526174;
  font-size: 11.5px;
  font-weight: 500;
}

.authority rect {
  fill: #eef0ff;
  stroke: #7780dc;
}

.standard rect {
  fill: #f4f1ff;
  stroke: #9a86d8;
}

.spaces rect {
  fill: #e9faf5;
  stroke: #40bca8;
}

.feedgen rect {
  fill: #e8f6fb;
  stroke: #499fbe;
  stroke-width: 2;
}

.lane-title {
  fill: #43506a;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.025em;
}

.standard-title,
.standard-label {
  fill: #6458a7;
}

.spaces-title,
.spaces-label {
  fill: #187d70;
}

.flow-label,
.authority-label,
.footnote {
  font-size: 11.5px;
  font-weight: 700;
}

.authority-label,
.footnote {
  fill: #586684;
}

figcaption {
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.5;
  padding: 0.65rem 0.75rem 0;
}

:global(.dark) .lane rect {
  fill: #172235;
  stroke: #435472;
}

:global(.dark) .spaces-lane rect {
  fill: #133a3e;
  stroke: #3c8279;
}

:global(.dark) .card rect {
  fill: #172235;
  stroke: #61749a;
}

:global(.dark) .authority rect {
  fill: #29275d;
  stroke: #9ca4ef;
}

:global(.dark) .standard rect {
  fill: #332653;
  stroke: #b69aeb;
}

:global(.dark) .spaces rect {
  fill: #163e42;
  stroke: #61d1c2;
}

:global(.dark) .feedgen rect {
  fill: #173b48;
  stroke: #72c6df;
}

:global(.dark) .card text {
  fill: #eef4ff;
}

:global(.dark) .card .detail,
:global(.dark) .lane-title,
:global(.dark) .authority-label,
:global(.dark) .footnote {
  fill: #c5d0e5;
}

@keyframes handoff-packet {
  0%,
  12% {
    opacity: 0;
    transform: translate(0, 0);
  }
  26%,
  72% {
    opacity: 1;
  }
  40% {
    transform: translateY(22px);
  }
  86%,
  100% {
    opacity: 0;
    transform: translateY(26px);
  }
}

@keyframes standard-sync-packet {
  0%,
  12% {
    opacity: 0;
    transform: translate(0, 0);
  }
  26%,
  72% {
    opacity: 1;
  }
  54% {
    transform: translate(66px, 33px);
  }
  86%,
  100% {
    opacity: 0;
    transform: translate(170px, 53px);
  }
}

@keyframes spaces-sync-packet {
  0%,
  12% {
    opacity: 0;
    transform: translate(0, 0);
  }
  26%,
  72% {
    opacity: 1;
  }
  54% {
    transform: translate(-66px, 33px);
  }
  86%,
  100% {
    opacity: 0;
    transform: translate(-170px, 53px);
  }
}

@keyframes authority-packet {
  0%,
  12% {
    opacity: 0;
    transform: translateY(0);
  }
  26%,
  72% {
    opacity: 1;
  }
  86%,
  100% {
    opacity: 0;
    transform: translateY(214px);
  }
}
</style>

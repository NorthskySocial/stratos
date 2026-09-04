<template>
  <figure class="feedgen-architecture-diagram">
    <svg
      viewBox="0 0 900 530"
      role="img"
      aria-labelledby="feedgen-architecture-title feedgen-architecture-description"
    >
      <!--
        Coordinate plan (900 × 530): authority card 282–618 × 32–104;
        source repositories 48–348 and 552–852 × 166–258; Feedgen 282–618 ×
        336–420; request/response row 48–852 × 438–502. Packet origins sit on
        the corresponding connector paths, leaving a 32-unit edge margin.
      -->
      <title id="feedgen-architecture-title">Feed generator architecture</title>
      <desc id="feedgen-architecture-description">
        Stratos provides membership and credentials. The feed generator receives
        posts through a subscription from Stratos-custody repositories and pull
        sync from space repositories on member PDSs. It serves an authorized,
        hydrated feed to a viewer through that viewer's PDS.
      </desc>
      <defs>
        <marker
          id="feedgen-architecture-arrow"
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
        class="flow-line authority-flow"
        fill="none"
        marker-end="url(#feedgen-architecture-arrow)"
      >
        <path d="M 450 104 V 142" />
      </g>
      <g
        class="flow-line subscription-flow"
        fill="none"
        marker-end="url(#feedgen-architecture-arrow)"
      >
        <path d="M 230 258 C 248 306 308 321 358 335" />
      </g>
      <g
        class="flow-line pull-flow"
        fill="none"
        marker-end="url(#feedgen-architecture-arrow)"
      >
        <path d="M 670 258 C 652 306 592 321 542 335" />
      </g>
      <g
        class="flow-line viewer-flow"
        fill="none"
        marker-end="url(#feedgen-architecture-arrow)"
      >
        <path d="M 214 464 H 336" />
        <path d="M 544 464 H 667" />
      </g>
      <g
        class="response-line"
        fill="none"
        marker-end="url(#feedgen-architecture-arrow)"
      >
        <path d="M 667 486 H 214" />
      </g>

      <g class="card authority" transform="translate(282 32)">
        <rect width="336" height="72" rx="14" />
        <text x="168" y="29" text-anchor="middle">Stratos authority</text>
        <text class="detail" x="168" y="51" text-anchor="middle">
          enrollment · membership · space credentials
        </text>
      </g>
      <text class="flow-label" x="466" y="129">authority data</text>

      <g class="card stratos-repo" transform="translate(48 166)">
        <rect width="300" height="92" rx="14" />
        <text x="150" y="30" text-anchor="middle">
          Stratos-custody repository
        </text>
        <text class="detail" x="150" y="52" text-anchor="middle">
          standard AT Protocol write path
        </text>
        <text class="detail" x="150" y="73" text-anchor="middle">
          Stratos stores and signs the actor repo
        </text>
      </g>
      <g class="card pds-repo" transform="translate(552 166)">
        <rect width="300" height="92" rx="14" />
        <text x="150" y="30" text-anchor="middle">
          Member PDS space repository
        </text>
        <text class="detail" x="150" y="52" text-anchor="middle">
          space-aware AT Protocol write path
        </text>
        <text class="detail" x="150" y="73" text-anchor="middle">
          member stores and signs the space repo
        </text>
      </g>
      <text class="flow-label subscription-label" x="225" y="293">
        subscribeRecords
      </text>
      <text class="flow-label pull-label" x="612" y="293">
        credentialed pull sync
      </text>

      <g class="card feedgen" transform="translate(282 336)">
        <rect width="336" height="84" rx="14" />
        <text x="168" y="31" text-anchor="middle">Feed generator</text>
        <text class="detail" x="168" y="53" text-anchor="middle">
          verified, boundary-scoped record projection
        </text>
        <text class="detail" x="168" y="73" text-anchor="middle">
          record data is in memory by default
        </text>
      </g>

      <g class="card viewer" transform="translate(48 438)">
        <rect width="166" height="64" rx="12" />
        <text x="83" y="27" text-anchor="middle">Viewer app</text>
        <text class="detail" x="83" y="47" text-anchor="middle">
          asks for a feed
        </text>
      </g>
      <g class="card proxy" transform="translate(336 438)">
        <rect width="208" height="64" rx="12" />
        <text x="104" y="27" text-anchor="middle">Viewer's PDS proxy</text>
        <text class="detail" x="104" y="47" text-anchor="middle">
          service-auth request
        </text>
      </g>
      <g class="card delivery" transform="translate(667 438)">
        <rect width="185" height="64" rx="12" />
        <text x="92.5" y="27" text-anchor="middle">Hydrated feed</text>
        <text class="detail" x="92.5" y="47" text-anchor="middle">
          authorized records
        </text>
      </g>
      <g id="authority-packet" class="packet authority-packet">
        <circle cx="450" cy="118" r="5" />
      </g>
      <g id="subscription-packet" class="packet subscription-packet">
        <circle cx="233" cy="269" r="5" />
      </g>
      <g id="pull-sync-packet" class="packet pull-sync-packet">
        <circle cx="667" cy="269" r="5" />
      </g>
      <g id="viewer-packet" class="packet viewer-packet">
        <circle cx="552" cy="464" r="5" />
      </g>
      <g id="response-packet" class="packet response-packet">
        <circle cx="654" cy="486" r="5" />
      </g>
      <text class="flow-label" x="254" y="454">request</text>
      <text class="flow-label" x="560" y="454">viewer identity</text>
      <text class="response-label" x="440" y="511" text-anchor="middle">
        fully hydrated response
      </text>
    </svg>
    <figcaption>
      Feedgen joins two ingestion paths into one feed projection. It is a
      derived service: it does not decide space membership or own the source
      repositories.
    </figcaption>
  </figure>
</template>

<style scoped>
.feedgen-architecture-diagram {
  margin: 1.75rem 0;
}

svg {
  display: block;
  height: auto;
  max-width: 100%;
  overflow: visible;
}

.flow-line,
.response-line {
  color: #5f69c6;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 2.25;
}

.authority-flow,
.viewer-flow,
.response-line {
  color: #697997;
}

.pull-flow {
  color: #1e9e8b;
}

.response-line path {
  stroke-dasharray: 4 5;
}

.packet {
  fill: currentColor;
  opacity: 0;
  transform-box: fill-box;
  transform-origin: center;
  vector-effect: non-scaling-stroke;
}

.authority-packet,
.viewer-packet,
.response-packet {
  color: #697997;
}

.subscription-packet {
  color: #6458a7;
}

.pull-sync-packet {
  color: #1e9e8b;
}

@media (prefers-reduced-motion: no-preference) {
  .authority-packet {
    animation: authority-packet 2.8s cubic-bezier(0.65, 0, 0.35, 1) infinite;
  }

  .subscription-packet {
    animation: subscription-packet 2.8s cubic-bezier(0.65, 0, 0.35, 1) 0.35s
      infinite;
  }

  .pull-sync-packet {
    animation: pull-sync-packet 2.8s cubic-bezier(0.65, 0, 0.35, 1) 0.7s
      infinite;
  }

  .viewer-packet {
    animation: viewer-packet 2.8s cubic-bezier(0.65, 0, 0.35, 1) 1.05s infinite;
  }

  .response-packet {
    animation: response-packet 2.8s cubic-bezier(0.65, 0, 0.35, 1) 1.4s infinite;
  }
}

.card rect {
  fill: #fff;
  stroke: #c6cce0;
  stroke-width: 1.5;
}

.card text {
  fill: #172235;
  font-size: 16px;
  font-weight: 700;
}

.card .detail {
  fill: #526174;
  font-size: 12px;
  font-weight: 500;
}

.authority rect {
  fill: #eef0ff;
  stroke: #7780dc;
}

.stratos-repo rect {
  fill: #f4f1ff;
  stroke: #9a86d8;
}

.pds-repo rect {
  fill: #e9faf5;
  stroke: #40bca8;
}

.feedgen rect {
  fill: #e8f6fb;
  stroke: #499fbe;
  stroke-width: 2;
}

.proxy rect {
  fill: #f7f4eb;
  stroke: #b08b46;
}

.delivery rect {
  fill: #e8faf5;
  stroke: #40bca8;
}

.flow-label,
.response-label {
  fill: #586684;
  font-size: 12px;
  font-weight: 700;
}

.subscription-label {
  fill: #6458a7;
}

.pull-label {
  fill: #187d70;
}

figcaption {
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.5;
  padding: 0.65rem 0.75rem 0;
}

:global(.dark) .card rect {
  fill: #172235;
  stroke: #61749a;
}

:global(.dark) .authority rect {
  fill: #29275d;
  stroke: #9ca4ef;
}

:global(.dark) .stratos-repo rect {
  fill: #332653;
  stroke: #b69aeb;
}

:global(.dark) .pds-repo rect,
:global(.dark) .delivery rect {
  fill: #163e42;
  stroke: #61d1c2;
}

:global(.dark) .feedgen rect {
  fill: #173b48;
  stroke: #72c6df;
}

:global(.dark) .proxy rect {
  fill: #40351e;
  stroke: #e0c175;
}

:global(.dark) .card text {
  fill: #eef4ff;
}

:global(.dark) .card .detail,
:global(.dark) .flow-label,
:global(.dark) .response-label {
  fill: #c5d0e5;
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
    transform: translateY(22px);
  }
}

@keyframes subscription-packet {
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
    transform: translate(39px, 37px);
  }
  86%,
  100% {
    opacity: 0;
    transform: translate(112px, 67px);
  }
}

@keyframes pull-sync-packet {
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
    transform: translate(-39px, 37px);
  }
  86%,
  100% {
    opacity: 0;
    transform: translate(-112px, 67px);
  }
}

@keyframes viewer-packet {
  0%,
  12% {
    opacity: 0;
    transform: translateX(0);
  }
  26%,
  72% {
    opacity: 1;
  }
  86%,
  100% {
    opacity: 0;
    transform: translateX(106px);
  }
}

@keyframes response-packet {
  0%,
  12% {
    opacity: 0;
    transform: translateX(0);
  }
  26%,
  72% {
    opacity: 1;
  }
  86%,
  100% {
    opacity: 0;
    transform: translateX(-430px);
  }
}
</style>

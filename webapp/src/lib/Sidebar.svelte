<script lang="ts">
  import type { StratosEnrollment } from './stratos'
  import { enrollInStratos } from './stratos'

  interface Props {
    handle: string
    enrollment: StratosEnrollment | null
    serviceUrl: string
    allDomains: string[]
    enrolledDomains: string[]
    postCount: number
    userCount: number
    activeFeed: string | null
    onSelectFeed: (domain: string | null) => void
  }

  let {
    handle,
    enrollment,
    serviceUrl,
    allDomains,
    enrolledDomains,
    postCount,
    userCount,
    activeFeed,
    onSelectFeed,
  }: Props = $props()
</script>

<nav class="sidebar-nav">
  <div class="user-section">
    <div class="handle">@{handle}</div>
    {#if enrollment}
      <div class="status enrolled">
        <span class="dot"></span>
        Enrolled
      </div>
    {:else}
      <div class="status not-enrolled">
        <span class="dot"></span>
        Not Enrolled
      </div>
      {#if serviceUrl}
        <button class="enroll-btn" onclick={() => enrollInStratos(serviceUrl, handle)}>
          Enroll in Stratos
        </button>
      {/if}
    {/if}
  </div>

  <div class="section">
    <h3 class="section-title">Feed</h3>
    <button
      class="feed-btn"
      class:active={activeFeed === null}
      onclick={() => onSelectFeed(null)}
    >
      All domains
    </button>
    {#each enrolledDomains as domain}
      <button
        class="feed-btn"
        class:active={activeFeed === domain}
        onclick={() => onSelectFeed(domain)}
      >
        {domain}
      </button>
    {/each}
  </div>

  <div class="section">
    <h3 class="section-title">Current Feed</h3>
    <div class="stat-row">
      <span class="stat-label">Posts</span>
      <span class="stat-value">{postCount}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Users</span>
      <span class="stat-value">{userCount}</span>
    </div>
  </div>

  <div class="section">
    <h3 class="section-title">Domains on Stratos</h3>
    {#if allDomains.length === 0}
      <p class="muted">No domains discovered</p>
    {:else}
      <div class="domain-list">
        {#each allDomains as domain}
          <span
            class="domain-tag"
            class:enrolled-tag={enrolledDomains.includes(domain)}
          >
            {domain}
            {#if enrolledDomains.includes(domain)}
              <span class="check">✓</span>
            {/if}
          </span>
        {/each}
      </div>
    {/if}
  </div>

  {#if enrollment}
    <div class="section">
      <h3 class="section-title">Your Domains</h3>
      <div class="domain-list">
        {#each enrolledDomains as domain}
          <span class="domain-tag enrolled-tag">{domain}</span>
        {/each}
      </div>
    </div>
  {/if}
</nav>

<style>
  .sidebar-nav {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .user-section {
    padding: 1rem;
    border-bottom: 1px solid #eee;
  }

  .handle {
    font-weight: 600;
    font-size: 0.95rem;
    margin-bottom: 0.5rem;
    word-break: break-all;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    margin-bottom: 0.5rem;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }

  .enrolled .dot { background: #22c55e; }
  .not-enrolled .dot { background: #ef4444; }
  .enrolled { color: #16a34a; }
  .not-enrolled { color: #dc2626; }

  .enroll-btn {
    width: 100%;
    padding: 0.5rem;
    background: #0066ff;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .enroll-btn:hover { background: #0052cc; }

  .section {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #eee;
  }

  .section-title {
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #888;
    font-weight: 600;
  }

  .feed-btn {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.2rem;
    border: none;
    border-radius: 6px;
    background: none;
    font-size: 0.88rem;
    cursor: pointer;
    color: #333;
  }

  .feed-btn:hover { background: #f5f5f5; }

  .feed-btn.active {
    background: #e0e7ff;
    color: #3730a3;
    font-weight: 600;
  }

  .stat-row {
    display: flex;
    justify-content: space-between;
    padding: 0.2rem 0;
    font-size: 0.85rem;
  }

  .stat-label { color: #666; }
  .stat-value { font-weight: 600; color: #333; }

  .domain-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .domain-tag {
    background: #f3f4f6;
    color: #555;
    padding: 0.15rem 0.5rem;
    border-radius: 12px;
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }

  .enrolled-tag {
    background: #e0e7ff;
    color: #3730a3;
  }

  .check {
    font-size: 0.65rem;
    color: #16a34a;
  }

  .muted {
    margin: 0;
    color: #aaa;
    font-size: 0.82rem;
  }
</style>

<script lang="ts">
  import type { StratosEnrollment } from './stratos'
  import { enrollInStratos } from './stratos'

  interface Props {
    handle: string
    enrollment: StratosEnrollment | null
    serviceUrl: string
  }

  let { handle, enrollment, serviceUrl }: Props = $props()

  function handleEnroll() {
    if (enrollment) {
      enrollInStratos(enrollment.service, handle)
    }
  }
</script>

<div class="enrollment-indicator">
  <div class="handle">@{handle}</div>

  {#if enrollment}
    <div class="status enrolled">
      <span class="dot"></span>
      Enrolled
    </div>
    {#if enrollment.boundaries.length > 0}
      <div class="boundaries">
        {#each enrollment.boundaries as b}
          <span class="boundary-tag">{b.value}</span>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="status not-enrolled">
      <span class="dot"></span>
      Not Enrolled
    </div>
    {#if serviceUrl}
      <button class="enroll-btn" onclick={() => enrollInStratos(serviceUrl, handle)}>
        Enroll in Stratos
      </button>
    {:else}
      <p class="no-service">Set VITE_STRATOS_URL to enable enrollment</p>
    {/if}
  {/if}
</div>

<style>
  .enrollment-indicator {
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

  .enrolled .dot {
    background: #22c55e;
  }

  .not-enrolled .dot {
    background: #ef4444;
  }

  .enrolled {
    color: #16a34a;
  }

  .not-enrolled {
    color: #dc2626;
  }

  .boundaries {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-bottom: 0.5rem;
  }

  .boundary-tag {
    background: #f0f4ff;
    color: #3366cc;
    padding: 0.15rem 0.5rem;
    border-radius: 12px;
    font-size: 0.75rem;
  }

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

  .enroll-btn:hover {
    background: #0052cc;
  }

  .no-service {
    margin: 0;
    color: #888;
    font-size: 0.8rem;
  }
</style>

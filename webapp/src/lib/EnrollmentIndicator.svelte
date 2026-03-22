<script lang="ts">
  import type { StratosEnrollment, StratosServiceStatus } from './stratos'
  import { enrollInStratos } from './stratos'

  interface Props {
    handle: string
    enrollment: StratosEnrollment | null
    serviceUrl: string
    stratosStatus: StratosServiceStatus | null
    attestationVerified: boolean | null
  }

  let { handle, enrollment, serviceUrl, stratosStatus, attestationVerified }: Props = $props()
</script>

<div class="enrollment-indicator">
  <div class="handle">@{handle}</div>

  <div class="enrollment-group">
    <div class="enrollment-label">PDS Record</div>
    {#if enrollment}
      <div class="status enrolled">
        <span class="dot"></span>
        Enrolled
        {#if attestationVerified === true}
          <span class="badge verified" title="Attestation signature verified">✓</span>
        {:else if attestationVerified === false}
          <span class="badge unverified" title="Attestation could not be verified">⚠</span>
        {/if}
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
    {/if}
  </div>

  <div class="enrollment-group">
    <div class="enrollment-label">Service Status</div>
    {#if stratosStatus === null}
      <div class="status pending">
        <span class="dot"></span>
        Checking…
      </div>
    {:else if stratosStatus.enrolled}
      <div class="status enrolled">
        <span class="dot"></span>
        Enrolled
        {#if stratosStatus.active === false}
          <span class="badge inactive">(inactive)</span>
        {/if}
      </div>
    {:else}
      <div class="status not-enrolled">
        <span class="dot"></span>
        Not Enrolled
      </div>
    {/if}
  </div>

  {#if !enrollment && serviceUrl}
    <button class="enroll-btn" onclick={() => enrollInStratos(serviceUrl, handle)}>
      Enroll in Stratos
    </button>
  {/if}

  {#if enrollment && stratosStatus && !stratosStatus.enrolled}
    <div class="status-mismatch">
      PDS has enrollment record but service does not recognize this DID
    </div>
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

  .pending .dot {
    background: #f59e0b;
  }

  .enrolled {
    color: #16a34a;
  }

  .not-enrolled {
    color: #dc2626;
  }

  .pending {
    color: #d97706;
  }

  .enrollment-group {
    margin-bottom: 0.5rem;
  }

  .enrollment-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #999;
    margin-bottom: 0.15rem;
  }

  .badge {
    font-size: 0.75rem;
    margin-left: 0.25rem;
    font-weight: 600;
  }

  .badge.verified {
    color: #16a34a;
  }

  .badge.unverified {
    color: #f59e0b;
  }

  .badge.inactive {
    color: #9ca3af;
    font-weight: 400;
    font-size: 0.8rem;
  }

  .status-mismatch {
    background: #fef3c7;
    color: #92400e;
    font-size: 0.78rem;
    padding: 0.4rem 0.5rem;
    border-radius: 6px;
    margin-top: 0.4rem;
    line-height: 1.3;
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

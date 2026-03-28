<script lang="ts">
  import { getContext } from 'svelte'
  import type { OAuthSession } from '@atproto/oauth-client-browser'
  import {
    inspectRecord,
    parseAtUri,
    syntaxHighlightJson,
    type InspectorResult,
  } from './inspector'

  interface Props {
    uri: string
    onclose: () => void
  }

  let { uri, onclose }: Props = $props()

  const ctx = getContext<{ session: OAuthSession; serviceUrl: string }>('stratos-inspector')

  let loading = $state(true)
  let result: InspectorResult | null = $state(null)

  const parts = parseAtUri(uri)
  const pdsRecordAddress = `at://${parts.did}/${parts.collection}/${parts.rkey}`
  const stratosRecordAddress = `at://${parts.did}/${parts.collection}/${parts.rkey}`

  async function load() {
    loading = true
    result = null
    try {
      result = await inspectRecord(ctx.session, ctx.serviceUrl, uri)
    } catch (err) {
      result = {
        stub: null,
        record: null,
        stubError: err instanceof Error ? err.message : String(err),
        recordError: null,
      }
    } finally {
      loading = false
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose()
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
  }

  $effect(() => {
    void load()
  })

  function stubValueOnly(data: Record<string, unknown> | null): unknown {
    if (!data) return null
    return data.value ?? data
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" onclick={handleBackdropClick}>
  <div class="modal">
    <div class="modal-header">
      <div>
        <h2 class="modal-title">Record Inspector</h2>
        <p class="modal-subtitle">PDS stub → Stratos hydration reference chain</p>
      </div>
      <button class="close-btn" onclick={onclose}>&times;</button>
    </div>

    {#if loading}
      <div class="modal-loading">
        <span class="spinner"></span> Fetching records…
      </div>
    {:else if result}
      <div class="panels">
        <div class="panel stub-panel">
          <div class="panel-label">Public Record</div>
          <div class="panel-address" title={pdsRecordAddress}>{pdsRecordAddress}</div>
          <div class="panel-body">
            {#if result.stubNotFound}
              <div class="panel-not-found">
                <p>Stub record not found on PDS.</p>
                <p>Stubs are written asynchronously after a record is created — it may take a moment to appear. Try reopening the inspector shortly.</p>
              </div>
            {:else if result.stubError}
              <div class="panel-error">{result.stubError}</div>
            {:else if result.stub}
              <pre class="json-block">{@html syntaxHighlightJson(stubValueOnly(result.stub))}</pre>
            {:else}
              <div class="panel-empty">No stub found</div>
            {/if}
          </div>
        </div>

        <div class="panel-divider">
          <div class="divider-line"></div>
          <div class="divider-label">source.subject.uri</div>
          <div class="divider-arrow">→</div>
          <div class="divider-line"></div>
        </div>

        <div class="panel hydrated-panel">
          <div class="panel-label">Private Hydrated Record</div>
          <div class="panel-address" title={stratosRecordAddress}>{stratosRecordAddress}</div>
          <div class="panel-body">
            {#if result.recordError}
              <div class="panel-error">{result.recordError}</div>
            {:else if result.record}
              <pre class="json-block">{@html syntaxHighlightJson(result.record.value ?? result.record)}</pre>
            {:else}
              <div class="panel-empty">No record found</div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 2rem;
  }

  .modal {
    background: #fff;
    border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    width: 100%;
    max-width: 1200px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid #e5e7eb;
    flex-shrink: 0;
  }

  .modal-title {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 700;
    color: #1f2937;
  }

  .modal-subtitle {
    margin: 0.2rem 0 0;
    font-size: 0.78rem;
    color: #6b7280;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 1.5rem;
    color: #9ca3af;
    cursor: pointer;
    padding: 0 0.25rem;
    line-height: 1;
    border-radius: 4px;
  }

  .close-btn:hover {
    color: #374151;
    background: #f3f4f6;
  }

  .modal-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    color: #6b7280;
    font-size: 0.9rem;
    padding: 3rem;
  }

  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid #d1d5db;
    border-top-color: #6366f1;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .panels {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .panel-label {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.6rem 1rem 0.25rem;
    flex-shrink: 0;
  }

  .stub-panel .panel-label {
    color: #5b21b6;
    background: #f5f3ff;
  }

  .hydrated-panel .panel-label {
    color: #166534;
    background: #f0fdf4;
  }

  .panel-address {
    font-size: 0.68rem;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    color: #6b7280;
    padding: 0 1rem 0.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .stub-panel .panel-address {
    background: #f5f3ff;
    border-bottom: 1px solid #ede9fe;
  }

  .hydrated-panel .panel-address {
    background: #f0fdf4;
    border-bottom: 1px solid #dcfce7;
  }

  .panel-body {
    flex: 1;
    overflow: auto;
  }

  .panel-error {
    padding: 1rem;
    color: #b91c1c;
    font-size: 0.82rem;
    background: #fef2f2;
  }

  .panel-not-found {
    padding: 1rem;
    color: #92400e;
    font-size: 0.82rem;
    background: #fffbeb;
    border-left: 3px solid #f59e0b;
  }

  .panel-not-found p {
    margin: 0 0 0.4rem;
  }

  .panel-not-found p:last-child {
    margin: 0;
    opacity: 0.8;
  }

  .panel-empty {
    padding: 1rem;
    color: #9ca3af;
    font-size: 0.82rem;
    font-style: italic;
  }

  .json-block {
    margin: 0;
    padding: 1rem;
    font-size: 0.76rem;
    line-height: 1.55;
    overflow-x: auto;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    white-space: pre;
    color: #1f2937;
  }

  .json-block :global(.json-key) {
    color: #5b21b6;
  }

  .json-block :global(.json-str) {
    color: #166534;
  }

  .json-block :global(.json-num) {
    color: #b45309;
  }

  .json-block :global(.json-bool) {
    color: #0369a1;
    font-weight: 600;
  }

  .json-block :global(.json-null) {
    color: #9ca3af;
    font-style: italic;
  }

  .panel-divider {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    flex-shrink: 0;
    width: 2.5rem;
    background: #f9fafb;
    border-left: 1px solid #e5e7eb;
    border-right: 1px solid #e5e7eb;
  }

  .divider-line {
    flex: 1;
    width: 2px;
    background: #c4b5fd;
    min-height: 0.5rem;
  }

  .divider-label {
    font-size: 0.55rem;
    color: #7c3aed;
    writing-mode: vertical-lr;
    text-orientation: mixed;
    transform: rotate(180deg);
    white-space: nowrap;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  }

  .divider-arrow {
    color: #7c3aed;
    font-size: 1rem;
    font-weight: bold;
    transform: rotate(90deg);
  }
</style>

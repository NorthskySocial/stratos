<script lang="ts">
  import { getContext } from 'svelte'
  import type { OAuthSession } from '@atproto/oauth-client-browser'
  import { inspectRecord, syntaxHighlightJson, type InspectorResult } from './inspector'

  interface Props {
    uri: string
  }

  let { uri }: Props = $props()

  const ctx = getContext<{ session: OAuthSession; serviceUrl: string }>('stratos-inspector')

  let loading = $state(true)
  let result: InspectorResult | null = $state(null)

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

  $effect(() => {
    void load()
  })

  function stubValueOnly(data: Record<string, unknown> | null): unknown {
    if (!data) return null
    return data.value ?? data
  }
</script>

<div class="inspector">
  <div class="inspector-header">
    <span class="inspector-title">Record Inspector</span>
    <span class="inspector-subtitle">PDS stub → Stratos hydration reference chain</span>
  </div>

  {#if loading}
    <div class="inspector-loading">
      <span class="spinner"></span> Fetching records…
    </div>
  {:else if result}
    <div class="inspector-panels">
      <div class="panel stub-panel">
        <div class="panel-label">
          <span class="panel-icon">📄</span> PDS Stub Record
        </div>
        {#if result.stubError}
          <div class="panel-error">{result.stubError}</div>
        {:else if result.stub}
          <pre class="json-block">{@html syntaxHighlightJson(stubValueOnly(result.stub))}</pre>
        {:else}
          <div class="panel-empty">No stub found</div>
        {/if}
      </div>

      <div class="panel-arrow">
        <div class="arrow-line"></div>
        <div class="arrow-label">source.subject.uri</div>
        <div class="arrow-head">→</div>
      </div>

      <div class="panel hydrated-panel">
        <div class="panel-label">
          <span class="panel-icon">🔓</span> Hydrated Stratos Record
        </div>
        {#if result.recordError}
          <div class="panel-error">{result.recordError}</div>
        {:else if result.record}
          <pre class="json-block">{@html syntaxHighlightJson(result.record.value ?? result.record)}</pre>
        {:else}
          <div class="panel-empty">No record found</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .inspector {
    border-top: 1px dashed #c4b5fd;
    background: #f5f3ff;
    padding: 0.75rem;
    margin-top: 0.25rem;
  }

  .inspector-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.6rem;
  }

  .inspector-title {
    font-weight: 600;
    font-size: 0.8rem;
    color: #5b21b6;
  }

  .inspector-subtitle {
    font-size: 0.7rem;
    color: #7c3aed;
    opacity: 0.7;
  }

  .inspector-loading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #7c3aed;
    font-size: 0.82rem;
    padding: 0.5rem 0;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid #c4b5fd;
    border-top-color: #7c3aed;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .inspector-panels {
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
  }

  .panel {
    flex: 1;
    min-width: 0;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    overflow: hidden;
  }

  .stub-panel {
    border-color: #c4b5fd;
  }

  .hydrated-panel {
    border-color: #86efac;
  }

  .panel-label {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid #f3f4f6;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .stub-panel .panel-label {
    background: #ede9fe;
    color: #5b21b6;
  }

  .hydrated-panel .panel-label {
    background: #ecfdf5;
    color: #166534;
  }

  .panel-icon {
    font-size: 0.85rem;
  }

  .panel-error {
    padding: 0.5rem 0.6rem;
    color: #b91c1c;
    font-size: 0.78rem;
    background: #fef2f2;
  }

  .panel-empty {
    padding: 0.5rem 0.6rem;
    color: #9ca3af;
    font-size: 0.78rem;
    font-style: italic;
  }

  .json-block {
    margin: 0;
    padding: 0.5rem 0.6rem;
    font-size: 0.72rem;
    line-height: 1.5;
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

  .panel-arrow {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    flex-shrink: 0;
    padding: 0 0.15rem;
    min-width: 2rem;
  }

  .arrow-line {
    flex: 1;
    width: 2px;
    background: #c4b5fd;
    min-height: 1rem;
  }

  .arrow-label {
    font-size: 0.6rem;
    color: #7c3aed;
    writing-mode: vertical-lr;
    text-orientation: mixed;
    transform: rotate(180deg);
    white-space: nowrap;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  }

  .arrow-head {
    color: #7c3aed;
    font-size: 1.1rem;
    font-weight: bold;
    transform: rotate(90deg);
  }
</style>

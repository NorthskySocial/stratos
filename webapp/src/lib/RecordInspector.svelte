<script lang="ts">
  import { getContext, onMount, untrack } from 'svelte'
  import type { OAuthSession } from '@atproto/oauth-client-browser'
  import {
    chooseInspectorSource,
    loadInspectorRecord,
    snapshotFromEntry,
    syntaxHighlightJson,
    type InspectorEntry,
    type InspectorOutcome,
    type InspectorSource,
    type OwnSpaceRead,
  } from './inspector'

  interface Props {
    uri: string
    cid?: string
    record?: Record<string, unknown>
    indexedAt?: string
    onclose: () => void
  }

  let { uri, cid = '', record, indexedAt, onclose }: Props = $props()

  const ctx = getContext<
    { session: OAuthSession | null; serviceUrl: string } | undefined
  >('stratos-inspector')

  const openedWithSession = ctx?.session ?? null
  const INVALID_ADDRESS = 'This record address is not valid'
  const SUBTITLES: Record<InspectorSource, string> = {
    custody:
      'What the PDS shows publicly, and what Stratos holds privately',
    'own-space': 'Read from your PDS with your sign-in',
    'feed-snapshot': 'The copy the feed already served',
    invalid: '',
  }

  let dialog = $state<HTMLDialogElement>()
  let answer = $state<{ uri: string; outcome: InspectorOutcome } | null>(null)
  let retryCount = $state(0)
  let latestRequest = 0
  let opener: HTMLElement | null = null

  const entry = $derived<InspectorEntry>({
    uri,
    cid,
    ...(record ? { record } : {}),
    ...(indexedAt ? { indexedAt } : {}),
  })
  // A feed refresh hands over a new post object with the same address. Reading
  // the address through a derived keeps an unchanged string from re-running
  // the read.
  const address = $derived(uri)
  const sessionUnchanged = $derived(
    (ctx?.session ?? null) === openedWithSession,
  )
  const source = $derived<InspectorSource | null>(
    openedWithSession
      ? chooseInspectorSource({ uri: address }, openedWithSession.sub)
      : null,
  )
  const signedOut = $derived(sessionUnchanged && !openedWithSession)
  // A snapshot and an invalid address need no request, so they follow the
  // entry as it is now; only the two reads wait for an answer.
  const outcome = $derived.by((): InspectorOutcome | null => {
    if (!sessionUnchanged || !source) return null
    if (source === 'feed-snapshot') {
      return { source, snapshot: snapshotFromEntry(entry) }
    }
    if (source === 'invalid') return { source }
    return answer?.uri === address ? answer.outcome : null
  })
  const loading = $derived(
    sessionUnchanged &&
      (source === 'custody' || source === 'own-space') &&
      outcome === null,
  )
  const subtitle = $derived(sessionUnchanged && source ? SUBTITLES[source] : '')

  function failedOutcome(
    failedSource: 'custody' | 'own-space',
    error: unknown,
  ): InspectorOutcome {
    if (failedSource === 'own-space') {
      return { source: failedSource, read: { kind: 'failed' } }
    }
    return {
      source: failedSource,
      result: {
        stub: null,
        record: null,
        stubError: error instanceof Error ? error.message : String(error),
        stubNotFound: false,
        recordError: null,
      },
    }
  }

  onMount(() => {
    opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
  })

  $effect(() => {
    if (sessionUnchanged) return
    latestRequest += 1
    answer = null
    dialog?.close()
  })

  $effect(() => {
    void retryCount
    const readAddress = address
    const session = ctx?.session ?? null
    // After a session change the dialog is closing; it never reads with the
    // replacement session.
    if (!session || session !== openedWithSession) return
    if (source !== 'custody' && source !== 'own-space') return
    const readSource = source
    const target = untrack(() => entry)
    const serviceUrl = untrack(() => ctx?.serviceUrl ?? '')
    const request = ++latestRequest
    answer = null
    void loadInspectorRecord(session, serviceUrl, target)
      .then((loaded) => {
        if (request === latestRequest) {
          answer = { uri: readAddress, outcome: loaded }
        }
      })
      .catch((error: unknown) => {
        if (request !== latestRequest) return
        answer = { uri: readAddress, outcome: failedOutcome(readSource, error) }
      })
    return () => {
      latestRequest += 1
    }
  })

  $effect(() => {
    if (dialog && !dialog.open) {
      dialog.showModal()
    }
  })

  function handleCancel(event: Event) {
    event.preventDefault()
    dialog?.close()
  }

  function handleClose() {
    if (opener?.isConnected) opener.focus()
    onclose()
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      dialog?.close()
    }
  }

  function stubValueOnly(data: Record<string, unknown> | null): unknown {
    if (!data) return null
    return data.value ?? data
  }

  function ownRecordMessage(read: Exclude<OwnSpaceRead, { kind: 'found' }>) {
    if (read.kind === 'unauthorized')
      return 'Your sign-in is no longer valid. Sign in again to read this record.'
    if (read.kind === 'unreachable') return 'Your PDS could not be reached.'
    if (read.kind === 'failed') return 'Your record could not be read.'
    switch (read.name) {
      case 'RepoNotFound':
        return 'Your PDS could not find your repository for this space.'
      case 'RecordNotFound':
        return 'Your PDS has no such record in this space.'
      case 'SpaceNotFound':
        return 'Your PDS does not know this space.'
      case 'RepoTakendown':
      case 'RepoSuspended':
      case 'RepoDeactivated':
        return 'Your PDS is not serving your repository right now.'
      default:
        return `Your PDS could not return this record (HTTP ${read.status}).`
    }
  }

  function indexedLabel(value: string): string {
    const time = new Date(value)
    return Number.isNaN(time.getTime()) ? value : time.toLocaleString()
  }
</script>

<dialog bind:this={dialog} class="modal" aria-labelledby="inspector-title" aria-busy={loading} oncancel={handleCancel} onclose={handleClose} onclick={handleBackdropClick}>
    <div class="modal-header">
      <div>
        <h2 id="inspector-title" class="modal-title">Record Inspector</h2>
        {#if subtitle}<p class="modal-subtitle">{subtitle}</p>{/if}
      </div>
      <button class="close-btn" type="button" onclick={() => dialog?.close()} aria-label="Close record inspector">&times;</button>
    </div>

    {#if loading}
      <div class="modal-loading" role="status">
        <span class="spinner"></span> Fetching records…
      </div>
    {:else if signedOut}
      <div class="modal-message" role="status">Sign in to inspect this record.</div>
    {:else if outcome?.source === 'invalid'}
      <div class="modal-message" role="alert">{INVALID_ADDRESS}</div>
    {:else if outcome?.source === 'custody'}
      <div class="panels">
        <div class="panel stub-panel">
          <div class="panel-label">Public Record</div>
          <div class="panel-address" title={uri}>{uri}</div>
          <div class="panel-body">
            {#if outcome.result.stubNotFound}
              <div class="panel-not-found">
                <p>Stub record not found on PDS.</p>
                <p>Stubs are written asynchronously after a record is created — it may take a moment to appear. Try reopening the inspector shortly.</p>
              </div>
            {:else if outcome.result.stubError}
              <div class="panel-error">{outcome.result.stubError}</div>
            {:else if outcome.result.stub}
              <pre class="json-block">{@html syntaxHighlightJson(stubValueOnly(outcome.result.stub))}</pre>
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
          <div class="panel-address" title={uri}>{uri}</div>
          <div class="panel-body">
            {#if outcome.result.recordError}
              <div class="panel-error">{outcome.result.recordError}</div>
            {:else if outcome.result.record}
              <pre class="json-block">{@html syntaxHighlightJson(outcome.result.record.value ?? outcome.result.record)}</pre>
            {:else}
              <div class="panel-empty">No record found</div>
            {/if}
          </div>
        </div>
      </div>
    {:else if outcome?.source === 'own-space'}
      <div class="panels">
        <div class="panel own-panel">
          <div class="panel-label">Your record on your PDS</div>
          <div class="panel-address" title={uri}>{uri}</div>
          <div class="panel-body">
            {#if outcome.read.kind === 'found'}
              <pre class="json-block">{@html syntaxHighlightJson(outcome.read.value)}</pre>
            {:else}
              <div class="panel-error" role="alert">{ownRecordMessage(outcome.read)}</div>
              <button class="retry-btn" type="button" onclick={() => (retryCount += 1)}>Try again</button>
            {/if}
          </div>
        </div>
      </div>
    {:else if outcome?.source === 'feed-snapshot'}
      <div class="panels">
        <div class="panel snapshot-panel">
          <div class="panel-label">Feed snapshot</div>
          <div class="panel-address" title={uri}>{uri}</div>
          <div class="panel-note">This is the copy the feed served, not a live read from the PDS.</div>
          <div class="panel-body">
            {#if outcome.snapshot}
              <p class="panel-meta">
                Indexed
                {#if outcome.snapshot.indexedAt}
                  <time datetime={outcome.snapshot.indexedAt}>{indexedLabel(outcome.snapshot.indexedAt)}</time>
                {:else}
                  at a time the feed did not report
                {/if}
              </p>
              <pre class="json-block">{@html syntaxHighlightJson(outcome.snapshot.record)}</pre>
            {:else}
              <div class="panel-empty">The feed did not keep a copy of this record, so there is nothing to show here.</div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
</dialog>

<style>
  .modal {
    border: 0;
    background: #fff;
    border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    width: 100%;
    max-width: 1200px;
    max-height: 90vh;
    overflow: hidden;
  }

  .modal[open] {
    display: flex;
    flex-direction: column;
  }

  .modal::backdrop {
    background: rgba(0, 0, 0, 0.5);
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

  .close-btn:focus-visible {
    outline: 3px solid #1d4ed8;
    outline-offset: 2px;
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

  .modal-message {
    padding: 2rem 1.5rem;
    color: #374151;
    font-size: 0.9rem;
  }

  .own-panel .panel-label {
    color: #1e40af;
    background: #eff6ff;
  }

  .own-panel .panel-address {
    background: #eff6ff;
    border-bottom: 1px solid #dbeafe;
  }

  .snapshot-panel .panel-label {
    color: #92400e;
    background: #fffbeb;
  }

  .snapshot-panel .panel-address {
    background: #fffbeb;
    border-bottom: 1px solid #fef3c7;
  }

  .panel-note {
    padding: 0.5rem 1rem;
    color: #92400e;
    font-size: 0.78rem;
    background: #fffbeb;
    border-bottom: 1px solid #fef3c7;
  }

  .panel-meta {
    margin: 0;
    padding: 0.75rem 1rem 0;
    color: #6b7280;
    font-size: 0.78rem;
  }

  .retry-btn {
    margin: 0 1rem 1rem;
    padding: 0.4rem 0.9rem;
    border: 1px solid #1d4ed8;
    border-radius: 6px;
    color: #1d4ed8;
    background: #fff;
    font: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }

  .retry-btn:focus-visible {
    outline: 3px solid #1d4ed8;
    outline-offset: 2px;
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

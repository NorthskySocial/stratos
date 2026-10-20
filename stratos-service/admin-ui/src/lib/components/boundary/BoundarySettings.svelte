<script lang="ts">
  import { getContext, onMount, tick, untrack } from 'svelte'
  import { updateBoundary, deactivateBoundary, reactivateBoundary, type BoundaryDetails } from '../../api/boundary-catalog'
  import { ApiError } from '../../api/client'
  import { editBoundaryDraft } from '../../boundary-form'
  import { BOUNDARY_NAVIGATION, boundaryDraftChanged, createSettingsPreview, settingsPreviewMatches, type BoundaryNavigation, type SettingsPreview } from '../../boundary-workspace'
  import BoundaryForm from '../boundaries/BoundaryForm.svelte'
  import Button from '../ui/Button.svelte'
  import Card from '../ui/Card.svelte'

  let { boundary, loading, onrefresh, onreplace, onclose }: {
    boundary: BoundaryDetails
    loading: boolean
    onrefresh: () => Promise<BoundaryDetails[]>
    onreplace: (boundary: BoundaryDetails) => void
    onclose: () => void
  } = $props()
  let editing = $state(untrack(() => boundary))
  let draft = $state(untrack(() => editBoundaryDraft(boundary)))
  let initialDraft = $state(untrack(() => editBoundaryDraft(boundary)))
  let preview = $state<SettingsPreview | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let refreshError = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let conflict = $state(false)
  let needsReload = $state(false)
  let confirming = $state<BoundaryDetails | null>(null)
  let lifecycleIntent = $state<'deactivate' | 'reactivate' | null>(null)
  let editorHeading = $state<HTMLHeadingElement>()
  let confirmationHeading = $state<HTMLHeadingElement>()
  let errorNotice = $state<HTMLDivElement>()
  let alive = true
  const navigation = getContext<BoundaryNavigation>(BOUNDARY_NAVIGATION)
  const dirty = $derived(boundaryDraftChanged(draft, initialDraft))
  $effect(() => {
    if (boundary.revision !== editing.revision) {
      editing = boundary
      preview = null
    }
    if (preview && !settingsPreviewMatches(preview, draft, editing)) preview = null
  })
  onMount(() => {
    editorHeading?.focus()
    const unregister = navigation.register({ isDirty: () => dirty || busy, discard: reset })
    return () => { alive = false; unregister() }
  })

  function reset() {
    draft = editBoundaryDraft(editing)
    initialDraft = editBoundaryDraft(editing)
    preview = null
    confirming = null
    lifecycleIntent = null
  }

  function cancel() {
    if (dirty) lifecycleIntent = null
    onclose()
  }

  async function refresh() {
    try {
      await onrefresh()
      if (alive) refreshError = null
    } catch {
      if (alive) refreshError = 'The boundary catalog could not be refreshed. Your form values are still here. Retry loading.'
    }
  }

  async function reload() {
    try {
      const current = (await onrefresh()).find(item => item.boundary === editing.boundary)
      if (!alive) return
      if (!current) throw new Error('The boundary is no longer in the catalog.')
      editing = current
      if (confirming) confirming = current
      preview = null
      conflict = true
      needsReload = false
      error = 'This boundary changed while you were working. Your form values are still here. Review the current saved settings below before trying again.'
    } catch {
      if (alive) error = 'This boundary changed, but its current settings could not be loaded. Your form values are still here. Retry loading before saving.'
    }
  }

  async function recover(err: unknown) {
    if (!alive) return
    preview = null
    error = err instanceof Error ? err.message : String(err)
    if (err instanceof ApiError && err.code === 'BoundaryConflict') {
      needsReload = true
      await reload()
    }
    await tick()
    errorNotice?.focus()
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (busy || loading || needsReload) return
    if (!preview || !settingsPreviewMatches(preview, draft, editing)) {
      preview = createSettingsPreview(draft, editing)
      return
    }
    const submitted = preview
    busy = true
    error = null
    try {
      const result = await updateBoundary(submitted.boundary, submitted.revision, submitted.settings)
      if (!alive) return
      onreplace(result.boundary)
      editing = result.boundary
      reset()
      notice = `${result.boundary.displayName} saved.`
    } catch (err) { await recover(err) }
    finally { if (alive) busy = false }
  }

  async function requestLifecycle(intent: 'deactivate' | 'reactivate') {
    if (busy || loading || needsReload || editing.reserved) return
    if (dirty) { lifecycleIntent = intent; return }
    if (intent === 'reactivate') { await reactivate(); return }
    confirming = editing
    await tick()
    confirmationHeading?.focus()
  }

  async function discardForLifecycle() {
    const intent = lifecycleIntent
    reset()
    if (intent) await requestLifecycle(intent)
  }

  async function deactivate() {
    if (!confirming || busy || loading || needsReload || confirming.status !== 'active' || confirming.reserved) return
    if (dirty) {
      confirming = null
      lifecycleIntent = 'deactivate'
      return
    }
    busy = true
    error = null
    try {
      const result = await deactivateBoundary(confirming.boundary, confirming.revision)
      if (!alive) return
      editing = result.boundary
      onreplace(result.boundary)
      reset()
      notice = result.boundary.status === 'inactive'
        ? `${result.boundary.displayName} is inactive. Its members have been removed; its records, name and history are retained.`
        : `Removing members from ${result.boundary.displayName}. Progress refreshes automatically.`
    } catch (err) { await recover(err) }
    finally { if (alive) busy = false }
  }

  async function reactivate() {
    if (busy || editing.status !== 'inactive') return
    busy = true
    error = null
    try {
      const result = await reactivateBoundary(editing.boundary, editing.revision)
      if (!alive) return
      editing = result.boundary
      onreplace(result.boundary)
      reset()
      notice = `${result.boundary.displayName} is active again. Previous members have not been re-added.`
    } catch (err) { await recover(err) }
    finally { if (alive) busy = false }
  }
</script>

<div class="space-y-6" data-testid="boundary-settings">
  {#if error}
    <div bind:this={errorNotice} tabindex="-1" role="alert" class="space-y-3">
      <p class="text-error">{error}</p>
      <Button variant="secondary" onclick={reload} disabled={loading || busy}>Retry loading</Button>
    </div>
  {/if}
  {#if refreshError}
    <div role="alert" class="space-y-3">
      <p class="text-error">{refreshError}</p>
      <Button variant="secondary" onclick={refresh} disabled={loading || busy}>Retry loading</Button>
    </div>
  {/if}
  {#if notice}<p role="status" class="text-sm text-purple dark:text-mint">{notice}</p>{/if}
    <Card testid="boundary-editor">
      <h2
        bind:this={editorHeading}
        tabindex="-1"
        class="mb-2 font-display text-lg"
      >
        Edit {editing.displayName}
      </h2>
      {#if editing}<p class="mb-5 break-all text-xs text-muted">
          {editing.boundary}
        </p>{/if}
      {#if conflict && editing}
        <details class="mb-5 rounded-2xl bg-bubble p-4 text-sm" open>
          <summary class="cursor-pointer font-semibold"
            >Current saved settings</summary
          >
          <dl class="mt-3 space-y-2">
            <div>
              <dt class="text-muted">Display name</dt>
              <dd>{editing.displayName}</dd>
            </div>
            <div>
              <dt class="text-muted">Description</dt>
              <dd class="whitespace-pre-wrap break-words">
                {editing.description || 'No description'}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Joining</dt>
              <dd>
                {editing.joinable
                  ? 'Members may join'
                  : 'Admin-managed membership'} · {editing.autoEnroll
                  ? 'New enrollments added'
                  : 'No automatic enrollment'}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Directory</dt>
              <dd>{editing.listed ? 'Publicly listed' : 'Unlisted'}</dd>
            </div>
            <div>
              <dt class="text-muted">App access</dt>
              <dd class="break-all">
                {editing.appAccess === 'open'
                  ? 'Any authorized app'
                  : editing.clientIds.join(', ')}
              </dd>
            </div>
          </dl>
        </details>
      {/if}
      {#if editing && editing.status !== 'active'}
        <p class="mb-5 text-sm text-muted">
          This boundary is {editing.status}. Settings can be saved, but
          membership stays closed until it is active again.
        </p>
      {/if}
      <form onsubmit={save} class="space-y-6">
        <BoundaryForm
          bind:draft
          creating={false}
          reserved={editing?.reserved ?? false}
          disabled={busy}
        />
        {#if preview}
          <section data-testid="settings-preview" class="rounded-2xl bg-bubble p-4" aria-label="Settings preview">
            <h3 class="font-semibold">Review settings</h3>
            <p class="mt-2 text-sm">Changing settings invalidates earlier local boundary credentials.</p>
            <h4 class="mt-3 font-semibold">Before · revision {preview.revision}</h4>
            <pre data-testid="settings-before" class="whitespace-pre-wrap break-all text-xs">{JSON.stringify(preview.before, null, 2)}</pre>
            <h4 class="mt-3 font-semibold">After</h4>
            <pre data-testid="settings-after" class="whitespace-pre-wrap break-all text-xs">{JSON.stringify(preview.settings, null, 2)}</pre>
            <Button variant="secondary" onclick={() => preview = null}>Cancel review</Button>
          </section>
        {/if}
        <div class="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy || loading || needsReload}
            >{busy
              ? 'Saving…'
              : preview ? 'Confirm save' : 'Save changes'}</Button
          >
          <Button variant="secondary" onclick={cancel} disabled={busy}
            >Cancel</Button
          >
        </div>
      </form>
    </Card>
  {#if confirming}
    <Card testid="deactivation-confirmation">
      <h2
        bind:this={confirmationHeading}
        tabindex="-1"
        class="mb-3 font-display text-lg"
      >
        Deactivate {confirming.displayName}?
      </h2>
      <p class="text-sm">
        All {confirming.memberCount} members will be removed. New joins and access
        will stop. Records and the boundary name will be retained. History is retained too.
      </p>
      <p class="mt-3 text-sm text-muted">
        You can reactivate this boundary later. Previous members will not be
        added back automatically.
      </p>
      {#if confirming.status !== 'active'}<p class="mt-3 text-sm" role="status">
          This boundary is already {confirming.status}.
        </p>{/if}
      <div class="mt-5 flex flex-wrap gap-3">
        <Button
          variant="danger"
          disabled={busy ||
            loading ||
            needsReload ||
            confirming.status !== 'active'}
          onclick={deactivate}
          >{busy ? 'Deactivating…' : 'Remove members and deactivate'}</Button
        >
        <Button variant="secondary" onclick={() => confirming = null} disabled={busy}
          >Cancel</Button
        >
      </div>
    </Card>
  {/if}


  <Card testid="boundary-lifecycle">
    <h2 class="font-display text-lg">Lifecycle</h2>
    <Button variant="secondary" disabled={loading || busy} onclick={refresh}>Refresh catalog</Button>
    <p class="mt-3 text-sm">Records, name and history are retained. Reactivation starts empty; previous memberships are not restored.</p>
    {#if editing.reserved}
      <p class="mt-3 text-sm">The all-members boundary cannot be deactivated.</p>
    {:else if editing.status === 'active'}
      <Button variant="secondary" disabled={busy || loading || needsReload} onclick={() => requestLifecycle('deactivate')}>Deactivate</Button>
    {:else if editing.status === 'inactive'}
      <Button variant="secondary" disabled={busy || loading || needsReload} onclick={() => requestLifecycle('reactivate')}>Reactivate</Button>
    {:else}
      <p role="status">Removing members: {editing.memberCount} remaining. Access is closed. Progress refreshes automatically.</p>
    {/if}
    {#if lifecycleIntent}
      <div tabindex="-1" role="alertdialog" aria-label="Discard settings before lifecycle action" class="mt-4 space-y-3">
        <p>Discard unsaved settings before continuing? No settings will be saved.</p>
        <Button variant="secondary" onclick={() => lifecycleIntent = null}>Review settings</Button>
        <Button variant="danger" onclick={discardForLifecycle}>Discard settings and continue</Button>
      </div>
    {/if}
  </Card>
</div>

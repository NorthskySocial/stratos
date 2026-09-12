<script lang="ts">
  import { onMount, tick } from 'svelte'
  import {
    createBoundary,
    deactivateBoundary,
    listBoundaries,
    reactivateBoundary,
    updateBoundary,
    type BoundaryDetails,
  } from '../lib/api/boundary-catalog'
  import { ApiError } from '../lib/api/client'
  import {
    boundarySettings,
    editBoundaryDraft,
    newBoundaryDraft,
    type BoundaryDraft,
  } from '../lib/boundary-form'
  import BoundaryForm from '../lib/components/boundaries/BoundaryForm.svelte'
  import Button from '../lib/components/ui/Button.svelte'
  import Card from '../lib/components/ui/Card.svelte'

  let boundaries = $state<BoundaryDetails[]>([])
  let loading = $state(true)
  let loaded = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let draft = $state<BoundaryDraft | null>(null)
  let editing = $state<BoundaryDetails | null>(null)
  let confirming = $state<BoundaryDetails | null>(null)
  let conflict = $state(false)
  let needsReload = $state(false)
  let editorHeading = $state<HTMLHeadingElement>()
  let confirmationHeading = $state<HTMLHeadingElement>()
  let errorNotice = $state<HTMLDivElement>()
  const pending = $derived(
    boundaries.some((item) => item.status === 'deactivating'),
  )

  async function load() {
    loading = true
    try {
      boundaries = (await listBoundaries()).boundaries
      loaded = true
      if (needsReload) applyConflictSnapshot()
      else if (!conflict) error = null
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => {
      if (pending && !loading && !busy) void load()
    }, 3_000)
    return () => clearInterval(timer)
  })

  function clearFeedback() {
    error = null
    notice = null
    conflict = false
    needsReload = false
  }

  async function startCreate() {
    clearFeedback()
    editing = null
    confirming = null
    draft = newBoundaryDraft()
    await tick()
    editorHeading?.focus()
  }

  async function startEdit(boundary: BoundaryDetails) {
    clearFeedback()
    editing = boundary
    confirming = null
    draft = editBoundaryDraft(boundary)
    await tick()
    editorHeading?.focus()
  }

  async function confirmDeactivation(boundary: BoundaryDetails) {
    clearFeedback()
    draft = null
    editing = null
    confirming = boundary
    await tick()
    confirmationHeading?.focus()
  }

  function replaceBoundary(boundary: BoundaryDetails) {
    boundaries = boundaries.some((item) => item.boundary === boundary.boundary)
      ? boundaries.map((item) =>
          item.boundary === boundary.boundary ? boundary : item,
        )
      : [...boundaries, boundary]
  }

  async function recover(err: unknown) {
    error = err instanceof Error ? err.message : String(err)
    if (!(err instanceof ApiError) || err.code !== 'BoundaryConflict') return
    needsReload = true
    try {
      boundaries = (await listBoundaries()).boundaries
      applyConflictSnapshot()
    } catch {
      error =
        'This boundary changed, but its current settings could not be loaded. Your form values are still here. Retry loading before saving.'
    }
  }

  function applyConflictSnapshot() {
    if (editing) {
      const current = boundaries.find(
        (item) => item.boundary === editing?.boundary,
      )
      if (!current)
        throw new Error(
          'The boundary is no longer in the catalog. Your form values have been kept.',
        )
      editing = current
    }
    if (confirming) {
      const current = boundaries.find(
        (item) => item.boundary === confirming?.boundary,
      )
      if (!current) throw new Error('The boundary is no longer in the catalog.')
      confirming = current
    }
    conflict = true
    needsReload = false
    error = draft
      ? 'This boundary changed while you were working. Your form values are still here. Review the current saved settings below before trying again.'
      : 'This boundary changed while you were working. Its current state has been reloaded. Review it before trying again.'
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (!draft || busy || loading || needsReload) return
    busy = true
    clearFeedback()
    try {
      const settings = boundarySettings(draft)
      const res = editing
        ? await updateBoundary(editing.boundary, editing.revision, settings)
        : await createBoundary(draft.name.trim(), settings)
      replaceBoundary(res.boundary)
      notice = `${res.boundary.displayName} saved.`
      draft = null
      editing = null
    } catch (err) {
      await recover(err)
      await tick()
      errorNotice?.focus()
    } finally {
      busy = false
    }
  }

  async function deactivate() {
    if (!confirming || busy || loading || needsReload) return
    busy = true
    clearFeedback()
    try {
      const res = await deactivateBoundary(
        confirming.boundary,
        confirming.revision,
      )
      replaceBoundary(res.boundary)
      confirming = null
      notice =
        res.boundary.status === 'inactive'
          ? `${res.boundary.displayName} is inactive. Its members have been removed; its records and name are retained.`
          : `Removing members from ${res.boundary.displayName}. Progress refreshes automatically.`
    } catch (err) {
      await recover(err)
      await tick()
      errorNotice?.focus()
    } finally {
      busy = false
    }
  }

  async function reactivate(boundary: BoundaryDetails) {
    busy = true
    clearFeedback()
    try {
      const res = await reactivateBoundary(boundary.boundary, boundary.revision)
      replaceBoundary(res.boundary)
      notice = `${res.boundary.displayName} is active again. Previous members have not been re-added.`
    } catch (err) {
      await recover(err)
      await tick()
      errorNotice?.focus()
    } finally {
      busy = false
    }
  }

  function closeEditor() {
    draft = null
    editing = null
    confirming = null
    clearFeedback()
  }
</script>

<div class="space-y-6" data-testid="boundaries-screen">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 class="font-display text-2xl font-semibold">Boundaries</h1>
      <p class="mt-2 max-w-xl text-sm text-muted">
        Manage who can join each private space and which apps can access it.
      </p>
    </div>
    <Button
      onclick={startCreate}
      disabled={busy || loading || draft !== null}
      testid="create-boundary">Add boundary</Button
    >
  </div>

  {#if error}
    <div bind:this={errorNotice} tabindex="-1" class="space-y-3" role="alert">
      <p class="text-error">{error}</p>
      <Button variant="secondary" onclick={load} disabled={loading || busy}
        >Retry loading</Button
      >
    </div>
  {/if}
  {#if notice}<p class="text-sm text-purple dark:text-mint" role="status">
      {notice}
    </p>{/if}

  {#if draft}
    <Card testid="boundary-editor">
      <h2
        bind:this={editorHeading}
        tabindex="-1"
        class="mb-2 font-display text-lg"
      >
        {editing ? `Edit ${editing.displayName}` : 'Add boundary'}
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
          creating={!editing}
          reserved={editing?.reserved ?? false}
          disabled={busy}
        />
        <div class="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy || loading || needsReload}
            >{busy
              ? 'Saving…'
              : editing
                ? 'Save changes'
                : 'Create boundary'}</Button
          >
          <Button variant="secondary" onclick={closeEditor} disabled={busy}
            >Cancel</Button
          >
        </div>
      </form>
    </Card>
  {/if}

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
        will stop. Records and the boundary name will be retained.
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
        <Button variant="secondary" onclick={closeEditor} disabled={busy}
          >Cancel</Button
        >
      </div>
    </Card>
  {/if}

  <Card testid="boundary-list">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 class="font-display text-lg">All boundaries</h2>
      <Button variant="secondary" onclick={load} disabled={loading || busy}
        >{loading ? 'Refreshing…' : 'Refresh'}</Button
      >
    </div>
    {#if !loaded}
      <p class="text-muted">
        {loading ? 'Loading boundaries…' : 'Boundaries could not be loaded.'}
      </p>
    {:else if boundaries.length === 0}
      <p class="text-sm text-muted">
        No boundaries yet. Add a boundary to define a private space and its
        membership rules.
      </p>
    {:else}
      <ul class="divide-y divide-muted/20">
        {#each boundaries as boundary (boundary.boundary)}
          <li
            class="space-y-3 py-5 first:pt-0 last:pb-0"
            data-testid="boundary-row"
          >
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0">
                <h3 class="break-words text-base font-semibold">
                  {boundary.displayName}
                </h3>
                <p class="mt-1 break-all text-xs text-muted">
                  {boundary.boundary}
                </p>
              </div>
              <span class="rounded-full bg-bubble px-3 py-1 text-xs font-medium"
                >{boundary.status === 'deactivating'
                  ? 'Removing members'
                  : boundary.status === 'active'
                    ? 'Active'
                    : 'Inactive'}</span
              >
            </div>
            {#if boundary.description}<p
                class="whitespace-pre-wrap break-words text-sm text-muted"
              >
                {boundary.description}
              </p>{/if}
            <p class="text-xs text-muted">
              {boundary.listed ? 'Publicly listed' : 'Unlisted'} · {boundary.joinable
                ? 'Self-service joining'
                : 'Admin-managed membership'} · {boundary.appAccess === 'open'
                ? 'Any authorized app'
                : 'Listed apps only'}
            </p>
            {#if boundary.status === 'deactivating'}
              <p class="text-sm" role="status">
                Removing members: {boundary.memberCount} remaining. Access is closed.
                This page refreshes automatically.
              </p>
            {:else if boundary.status === 'inactive'}
              <p class="text-sm text-muted">
                Membership is closed. Reactivating keeps the boundary empty
                until members join or an admin adds them.
              </p>
            {/if}
            {#if boundary.reserved}<p class="text-xs text-muted">
                All-members boundary · Automatic enrollment is required. This
                boundary cannot be deactivated.
              </p>{/if}
            <div class="flex flex-wrap items-center gap-3">
              <a
                class="pill squish px-4 py-2 text-sm no-underline"
                href="#/enrollments?boundary={encodeURIComponent(
                  boundary.boundary,
                )}">Members ({boundary.memberCount})</a
              >
              <Button
                variant="secondary"
                disabled={busy || loading || draft !== null}
                onclick={() => startEdit(boundary)}>Edit</Button
              >
              {#if !boundary.reserved && boundary.status === 'active'}
                <Button
                  variant="secondary"
                  disabled={busy || loading || draft !== null}
                  onclick={() => confirmDeactivation(boundary)}
                  >Deactivate</Button
                >
              {:else if !boundary.reserved && boundary.status === 'inactive'}
                <Button
                  variant="secondary"
                  disabled={busy || loading || draft !== null}
                  onclick={() => reactivate(boundary)}>Reactivate</Button
                >
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>
</div>

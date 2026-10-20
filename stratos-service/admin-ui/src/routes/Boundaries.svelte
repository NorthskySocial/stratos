<script module lang="ts">
  import { auth } from '../lib/stores/auth.svelte'

  let membershipSession = $state({
    operatorDid: auth.did,
    uncertain: new Set<string>(),
    pending: new Set<string>(),
  })

  $effect.root(() => {
    $effect(() => {
      const operatorDid = auth.status === 'authenticated' ? auth.did : null
      if (membershipSession.operatorDid !== operatorDid) {
        membershipSession = { operatorDid, uncertain: new Set(), pending: new Set() }
      }
    })
  })
</script>

<script lang="ts">
  import { getContext, onMount, tick } from 'svelte'
  let { route }: { route: { location: string; querystring: string } } = $props()
  import BoundaryOverview from '../lib/components/boundary/BoundaryOverview.svelte'
  import BoundarySettings from '../lib/components/boundary/BoundarySettings.svelte'
  import BoundaryMembers from '../lib/components/boundary/BoundaryMembers.svelte'
  import { BOUNDARY_NAVIGATION, boundaryDraftChanged, boundaryDetailHref, parseBoundarySelection, type BoundaryNavigation } from '../lib/boundary-workspace'
  import {
    createBoundary,
    listBoundaries,
    type BoundaryDetails,
  } from '../lib/api/boundary-catalog'
  import {
    boundarySettings,
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
  let catalogError = $state<string | null>(null)
  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let draft = $state<BoundaryDraft | null>(null)
  let initialDraft = $state<BoundaryDraft | null>(null)
  const navigation = getContext<BoundaryNavigation>(BOUNDARY_NAVIGATION)
  onMount(() => navigation.register({
    isDirty: () => draft !== null && initialDraft !== null && boundaryDraftChanged(draft, initialDraft),
    discard: closeEditor,
  }))
  let editorHeading = $state<HTMLHeadingElement>()
  let errorNotice = $state<HTMLDivElement>()
  const pending = $derived(
    boundaries.some((item) => item.status === 'deactivating'),
  )
  const selection = $derived.by(() => {
    route.querystring
    return route.location === '/boundaries/detail'
      ? parseBoundarySelection(route.querystring)
      : null
  })
  const selectedBoundary = $derived(
    selection?.valid
      ? boundaries.find((item) => item.boundary === selection.boundary) ?? null
      : null,
  )
  let catalogGeneration = 0
  const membershipOperations = membershipSession

  function membershipKey(did: string, boundary: string) {
    return JSON.stringify([did, boundary])
  }

  function markMembershipUncertain(did: string, boundary: string) {
    membershipOperations.uncertain = new Set([...membershipOperations.uncertain, membershipKey(did, boundary)])
  }

  function reconcileMembership(did: string, boundary: string) {
    const next = new Set(membershipOperations.uncertain)
    next.delete(membershipKey(did, boundary))
    membershipOperations.uncertain = next
  }

  async function load() {
    const catalogRequest = ++catalogGeneration
    loading = true
    try {
      const result = await listBoundaries()
      if (catalogRequest !== catalogGeneration) return boundaries
      boundaries = result.boundaries
      loaded = true
      catalogError = null
      return result.boundaries
    } catch (err) {
      if (catalogRequest !== catalogGeneration) return boundaries
      catalogError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      if (catalogRequest === catalogGeneration) loading = false
    }
  }

  $effect(() => {
    route.location
    route.querystring
    void load().catch(() => {})
  })

  onMount(() => {
    const timer = setInterval(() => {
      if (pending && !loading && !busy) void load().catch(() => {})
    }, 3_000)
    return () => { catalogGeneration++; clearInterval(timer) }
  })

  function clearFeedback() {
    error = null
    notice = null
  }

  async function startCreate() {
    clearFeedback()
    draft = newBoundaryDraft()
    initialDraft = { ...draft }
    await tick()
    editorHeading?.focus()
  }

  function replaceBoundary(boundary: BoundaryDetails) {
    catalogGeneration++
    loading = false
    boundaries = boundaries.some((item) => item.boundary === boundary.boundary)
      ? boundaries.map((item) =>
          item.boundary === boundary.boundary ? boundary : item,
        )
      : [...boundaries, boundary]
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (!draft || busy || loading) return
    busy = true
    clearFeedback()
    try {
      const res = await createBoundary(draft.name.trim(), boundarySettings(draft))
      replaceBoundary(res.boundary)
      notice = `${res.boundary.displayName} saved.`
      draft = null
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      await tick()
      errorNotice?.focus()
    } finally {
      busy = false
    }
  }

  function closeEditor() {
    draft = null
    initialDraft = null
    clearFeedback()
  }
</script>

{#if selection}
  <div class="space-y-6" data-testid="boundary-detail">
    {#if !selection.valid}
      <Card testid="boundary-not-found">
        <h1 class="font-display text-2xl font-semibold">Boundary not found</h1>
        <p class="mt-3 text-sm text-muted">The boundary link is missing or invalid. No changes were made.</p>
        <a class="mt-4 inline-block pill squish px-4 py-2 text-sm no-underline" href="#/boundaries">Return to boundaries</a>
      </Card>
    {:else if !loaded && catalogError}
      <div role="alert" class="space-y-3">
        <p class="text-error">The boundary catalog could not be loaded: {catalogError}</p>
        <Button variant="secondary" onclick={() => { void load().catch(() => {}) }} disabled={loading}>Retry loading</Button>
      </div>
    {:else if !loaded || (loading && !selectedBoundary)}
      <p class="text-muted" role="status">Loading boundary…</p>
    {:else if !selectedBoundary}
      <Card testid="boundary-not-found">
        <h1 class="font-display text-2xl font-semibold">Boundary not found</h1>
        <p class="mt-3 text-sm text-muted">This identifier is not in the current catalog.</p>
        <a class="mt-4 inline-block pill squish px-4 py-2 text-sm no-underline" href="#/boundaries">Return to boundaries</a>
      </Card>
    {:else}
      {#if catalogError && selection.tab !== 'settings'}
        <div role="alert" class="space-y-3">
          <p class="text-error">The boundary catalog could not be refreshed: {catalogError}</p>
          <Button variant="secondary" onclick={() => { void load().catch(() => {}) }} disabled={loading}>Retry loading</Button>
        </div>
      {/if}
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <a class="text-sm text-muted underline" href="#/boundaries">← All boundaries</a>
          <h1 class="mt-3 break-words font-display text-2xl font-semibold">{selectedBoundary.displayName}</h1>
          <p class="mt-2 break-all text-xs text-muted">{selectedBoundary.boundary}</p>
          <p class="mt-2 text-sm text-muted">{selectedBoundary.status === 'deactivating' ? 'Removing members' : selectedBoundary.status === 'active' ? 'Active' : 'Inactive'}</p>
        </div>
      </div>
      <nav aria-label="Boundary workspace" class="flex flex-wrap gap-2">
        <a aria-current={selection.tab === 'overview' ? 'page' : undefined} class={selection.tab === 'overview' ? 'grad-fill rounded-full px-4 py-2 text-sm font-semibold no-underline' : 'pill squish px-4 py-2 text-sm no-underline'} href={boundaryDetailHref(selectedBoundary.boundary, 'overview')}>Overview</a>
        <a aria-current={selection.tab === 'members' ? 'page' : undefined} class={selection.tab === 'members' ? 'grad-fill rounded-full px-4 py-2 text-sm font-semibold no-underline' : 'pill squish px-4 py-2 text-sm no-underline'} href={boundaryDetailHref(selectedBoundary.boundary, 'members')}>Members</a>
        <a aria-current={selection.tab === 'settings' ? 'page' : undefined} class="pill squish px-4 py-2 text-sm no-underline" href={boundaryDetailHref(selectedBoundary.boundary, 'settings')}>Settings</a>
      </nav>
      {#if selection.tab === 'members'}
        <BoundaryMembers
          boundary={selectedBoundary}
          onrefresh={load}
          uncertainMemberships={membershipOperations.uncertain}
          pendingMemberships={membershipOperations.pending}
          onMembershipPending={(did, boundary, pending) => {
            const next = new Set(membershipOperations.pending)
            if (pending) next.add(membershipKey(did, boundary))
            else next.delete(membershipKey(did, boundary))
            membershipOperations.pending = next
          }}
          onUncertainMembership={(did, boundary, uncertain) => {
            if (uncertain) markMembershipUncertain(did, boundary)
            else reconcileMembership(did, boundary)
          }}
        />
      {:else if selection.tab === 'settings'}
        {#key selectedBoundary.boundary}
          <BoundarySettings boundary={selectedBoundary} {loading} onrefresh={load} onreplace={replaceBoundary} onclose={() => { window.location.hash = '#/boundaries' }} />
        {/key}
      {:else}
        <BoundaryOverview boundary={selectedBoundary} />
      {/if}
    {/if}
  </div>
{:else}
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

  {#if catalogError}
    <div class="space-y-3" role="alert">
      <p class="text-error">The boundary catalog could not be loaded: {catalogError}</p>
      <Button variant="secondary" onclick={() => { void load().catch(() => {}) }} disabled={loading || busy}
        >Retry loading</Button
      >
    </div>
  {/if}
  {#if error}
    <div bind:this={errorNotice} tabindex="-1" class="space-y-3" role="alert">
      <p class="text-error">{error}</p>
      <Button variant="secondary" onclick={() => { void load().catch(() => {}) }} disabled={loading || busy}
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
        Add boundary
      </h2>
      <form onsubmit={save} class="space-y-6">
        <BoundaryForm
          bind:draft
          creating={true}
          reserved={false}
          disabled={busy}
        />
        <div class="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy || loading}>{busy ? 'Saving…' : 'Create boundary'}</Button>
          <Button variant="secondary" onclick={closeEditor} disabled={busy}
            >Cancel</Button
          >
        </div>
      </form>
    </Card>
  {/if}

  <Card testid="boundary-list">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 class="font-display text-lg">All boundaries</h2>
      <Button variant="secondary" onclick={() => { void load().catch(() => {}) }} disabled={loading || busy}
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
                href={boundaryDetailHref(boundary.boundary)}>Overview</a
              >
              <a
                class="text-sm text-muted underline"
                href="#/enrollments?boundary={encodeURIComponent(boundary.boundary)}">Global enrollments ({boundary.memberCount})</a
              >
              <a class="pill squish px-4 py-2 text-sm no-underline" href={boundaryDetailHref(boundary.boundary, 'settings')}>Edit</a>
              {#if !boundary.reserved}
                <a class="pill squish px-4 py-2 text-sm no-underline" href={boundaryDetailHref(boundary.boundary, 'settings')}>{boundary.status === 'inactive' ? 'Reactivate' : 'Deactivate'}</a>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>
</div>
{/if}

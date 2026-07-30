<script lang="ts">
  import { onMount } from 'svelte'
  import {
    addBoundary,
    getEnrollmentStatus,
    listDomains,
    listEnrollments,
    removeBoundary,
    resolveEnrollments,
    setBoundaries,
    type BoundariesResponse,
    type EnrollmentStatusResponse,
    type EnrollmentSummary,
  } from '../lib/api/client'
  import Button from '../lib/components/ui/Button.svelte'
  import Card from '../lib/components/ui/Card.svelte'
  import Chip from '../lib/components/ui/Chip.svelte'
  import Identity from '../lib/components/ui/Identity.svelte'
  import StatusDot from '../lib/components/ui/StatusDot.svelte'
  import TextField from '../lib/components/ui/TextField.svelte'
  import { resolveDid } from '../lib/api/identity'

  let searchDid = $state('')
  let loadedDid = $state<string | null>(null)
  let enrolled = $state(false)
  let boundaries = $state<string[]>([])
  let status = $state<EnrollmentStatusResponse | null>(null)
  let domains = $state<string[]>([])
  let selectedDomain = $state('')
  let setInput = $state('')
  let error = $state<string | null>(null)
  let warning = $state<string | null>(null)
  let busy = $state(false)

  const PAGE_SIZE = 25
  let members = $state<EnrollmentSummary[]>([])
  let membersCursor = $state<string | undefined>(undefined)
  let membersTotal = $state<number | undefined>(undefined)
  let membersLoading = $state(false)
  let membersLoaded = $state(false)
  let membersError = $state<string | null>(null)

  $effect(() => {
    listDomains()
      .then((res) => (domains = res.domains))
      .catch((err: unknown) => {
        error = `Failed to load allowed domains: ${
          err instanceof Error ? err.message : String(err)
        }`
      })
  })

  const availableDomains = $derived(
    domains.filter((domain) => !boundaries.includes(domain)),
  )

  async function loadMembers(cursor?: string) {
    if (membersLoading) return
    membersLoading = true
    membersError = null
    try {
      const res = await listEnrollments({ limit: PAGE_SIZE, cursor })
      members = cursor ? [...members, ...res.enrollments] : res.enrollments
      membersCursor = res.cursor
      membersTotal = res.total
      membersLoaded = true
    } catch (err) {
      membersError = err instanceof Error ? err.message : String(err)
    } finally {
      membersLoading = false
    }
  }

  // onMount, not $effect: the member list is loaded once on open. An $effect
  // would re-run whenever the reactive state read inside loadMembers changes.
  onMount(() => {
    void loadMembers()
  })

  /** Load one member's detail. Shared by the search box and the member list. */
  async function loadMember(did: string) {
    if (busy) return
    error = null
    warning = null
    busy = true
    // Clear the current member so a slow lookup cannot leave the previous
    // member's boundaries on screen next to the new DID.
    loadedDid = null
    boundaries = []
    status = null
    setInput = ''
    try {
      const res = await resolveEnrollments(did)
      loadedDid = res.did
      enrolled = res.enrolled
      boundaries = res.boundaries
      status = await getEnrollmentStatus(did).catch(() => null)
      setInput = res.boundaries.join(', ')
    } catch (err) {
      loadedDid = null
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function search() {
    const query = searchDid.trim()
    if (!query || busy) return
    let did = query
    if (!did.startsWith('did:')) {
      busy = true
      let resolved: string | null = null
      try {
        resolved = await resolveDid(did)
      } catch {
        resolved = null
      } finally {
        busy = false
      }
      if (!resolved) {
        error = `Could not resolve handle "${query}" to a DID`
        loadedDid = null
        return
      }
      did = resolved
    }
    await loadMember(did)
  }

  async function mutate(action: () => Promise<BoundariesResponse>) {
    if (busy) return
    error = null
    warning = null
    busy = true
    try {
      const res = await action()
      boundaries = res.boundaries
      setInput = res.boundaries.join(', ')
      // Keep the member list in step with the edit rather than refetching.
      members = members.map((member) =>
        member.did === res.did
          ? { ...member, boundaries: res.boundaries }
          : member,
      )
      if (res.pdsSync === 'failed') {
        warning =
          'Boundaries saved here, but the member\u2019s PDS enrollment record ' +
          'could not be updated. Retry to sync it.'
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function handleAdd() {
    if (!loadedDid || !selectedDomain || busy) return
    const did = loadedDid
    const boundary = selectedDomain
    selectedDomain = ''
    void mutate(() => addBoundary(did, boundary))
  }

  function handleRemove(boundary: string) {
    if (!loadedDid || busy) return
    const did = loadedDid
    void mutate(() => removeBoundary(did, boundary))
  }

  function handleSet() {
    if (!loadedDid || busy) return
    const did = loadedDid
    const next = setInput
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    void mutate(() => setBoundaries(did, next))
  }
</script>

<div class="space-y-6" data-testid="enrollments-screen">
  <h1 class="font-display text-2xl font-semibold">Enrollments</h1>

  <Card title="Look up a member">
    <div class="flex items-end gap-3">
      <div class="grow">
        <TextField
          bind:value={searchDid}
          ariaLabel="Member DID or handle"
          onenter={search}
          placeholder="did:plc:… or handle.example.com"
          testid="did-input"
        />
      </div>
      <Button disabled={busy || !searchDid.trim()} onclick={search} testid="did-search">
        Search
      </Button>
    </div>
    <p class="mt-3 text-xs text-muted">
      Search jumps straight to a member; the list below shows everyone
      enrolled.
    </p>
  </Card>

  <Card testid="members-card">
    <div class="mb-4 flex items-baseline justify-between">
      <h2 class="font-display text-lg italic">Members</h2>
      {#if membersTotal !== undefined}
        <span class="text-sm text-muted" data-testid="members-total">
          {members.length} of {membersTotal}
        </span>
      {/if}
    </div>

    {#if membersError}
      <div class="space-y-3" data-testid="members-error">
        <p class="text-error">Failed to load members: {membersError}</p>
        <Button
          disabled={membersLoading}
          onclick={() => loadMembers()}
          testid="members-retry"
          variant="secondary"
        >
          Retry
        </Button>
      </div>
    {:else if !membersLoaded && membersLoading}
      <p class="text-muted">Loading…</p>
    {:else if members.length === 0}
      <p class="text-muted" data-testid="members-empty">
        No members are enrolled yet.
      </p>
    {:else}
      <ul class="space-y-2" data-testid="members-list">
        {#each members as member (member.did)}
          <li>
            <button
              class="squish w-full cursor-pointer rounded-2xl bg-bubble p-4 text-left shadow-brand disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="member-row"
              disabled={busy}
              onclick={() => loadMember(member.did)}
              type="button"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <Identity did={member.did} />
                <div class="flex items-center gap-3">
                  {#if member.isService}
                    <span class="text-xs text-muted">service</span>
                  {/if}
                  <StatusDot
                    label={member.active ? 'active' : 'inactive'}
                    ok={member.active}
                  />
                </div>
              </div>
              {#if member.boundaries.length > 0}
                <div class="mt-2 flex flex-wrap gap-1.5">
                  {#each member.boundaries as boundary (boundary)}
                    <Chip label={boundary} />
                  {/each}
                </div>
              {/if}
            </button>
          </li>
        {/each}
      </ul>

      {#if membersCursor}
        <div class="mt-4">
          <Button
            disabled={membersLoading}
            onclick={() => loadMembers(membersCursor)}
            testid="members-load-more"
            variant="secondary"
          >
            {membersLoading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      {/if}
    {/if}
  </Card>

  {#if error}
    <Card><p class="text-error" data-testid="enrollments-error">{error}</p></Card>
  {/if}

  {#if warning}
    <Card>
      <p
        aria-live="polite"
        class="text-purple dark:text-mint"
        data-testid="enrollments-warning"
        role="status"
      >
        {warning}
      </p>
    </Card>
  {/if}

  {#if loadedDid}
    <Card testid="enrollment-detail">
      <div class="space-y-4">
        <h2 class="font-display text-lg italic">
          <Identity did={loadedDid} testid="enrollment-identity" />
        </h2>
        <div class="flex items-center gap-6">
          <StatusDot label={enrolled ? 'enrolled' : 'not enrolled'} ok={enrolled} />
          {#if status?.enrolledAt}
            <span class="text-sm text-muted">
              since {new Date(status.enrolledAt).toLocaleString()}
            </span>
          {/if}
          {#if status?.active === false}
            <span class="text-sm text-error">inactive</span>
          {/if}
        </div>

        <div>
          <h3 class="mb-2 text-sm font-medium text-muted">Boundaries</h3>
          {#if boundaries.length === 0}
            <p class="text-sm text-muted" data-testid="no-boundaries">
              No boundaries assigned.
            </p>
          {:else}
            <div class="flex flex-wrap gap-2">
              {#each boundaries as boundary (boundary)}
                <Chip
                  label={boundary}
                  onremove={busy ? undefined : () => handleRemove(boundary)}
                  removable
                  testid="boundary-chip"
                />
              {/each}
            </div>
          {/if}
        </div>

        {#if enrolled}
          <div class="flex items-end gap-3">
            <label class="block grow">
              <span class="mb-1 block text-sm font-medium text-muted">
                Add boundary
              </span>
              <select
                bind:value={selectedDomain}
                class="pill w-full cursor-pointer px-4 py-2 text-sm outline-none"
                data-testid="add-boundary-select"
              >
                <option value="">Select a domain…</option>
                {#each availableDomains as domain (domain)}
                  <option value={domain}>{domain}</option>
                {/each}
              </select>
            </label>
            <Button
              disabled={busy || !selectedDomain}
              onclick={handleAdd}
              testid="add-boundary"
            >
              Add
            </Button>
          </div>

          <div class="flex items-end gap-3">
            <div class="grow">
              <TextField
                bind:value={setInput}
                label="Set boundaries (comma-separated)"
                onenter={handleSet}
                placeholder="engineering, leadership"
                testid="set-boundaries-input"
              />
            </div>
            <Button
              disabled={busy}
              onclick={handleSet}
              testid="set-boundaries"
              variant="secondary"
            >
              Set
            </Button>
          </div>
        {/if}
      </div>
    </Card>
  {/if}
</div>

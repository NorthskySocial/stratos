<script lang="ts">
  import { onMount } from 'svelte'
  import { router } from 'svelte-spa-router'
  import {
    addBoundary,
    getEnrollmentStatus,
    getRepoHost,
    listDomains,
    listEnrollments,
    removeBoundary,
    resolveEnrollments,
    setActive,
    setBoundaries,
    type BoundariesResponse,
    type Custody,
    type EnrollmentStatusResponse,
    type EnrollmentSummary,
    type RepoHostResolution,
  } from '../lib/api/client'
  import Button from '../lib/components/ui/Button.svelte'
  import Card from '../lib/components/ui/Card.svelte'
  import Chip from '../lib/components/ui/Chip.svelte'
  import Identity from '../lib/components/ui/Identity.svelte'
  import StatusDot from '../lib/components/ui/StatusDot.svelte'
  import TextField from '../lib/components/ui/TextField.svelte'
  import { resolveDid } from '../lib/api/identity'
  import { boundaryName } from '../lib/boundaries'

  let searchDid = $state('')
  let loadedDid = $state<string | null>(null)
  let enrolled = $state(false)
  let boundaries = $state<string[]>([])
  let status = $state<EnrollmentStatusResponse | null>(null)
  let detailCustody = $state<Custody | null>(null)
  let detailIsService = $state(false)
  let hostResolutions = $state<RepoHostResolution[]>([])
  let hostError = $state<string | null>(null)
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
  /** Full boundary value, or '' for no filter. Seeded from the hash query. */
  let boundaryFilter = $state('')
  /** '' shows everyone, otherwise only active or only deactivated members. */
  let activeFilter = $state<'' | 'active' | 'inactive'>('')
  let custodyFilter = $state<'' | 'stratos' | 'pds'>('')

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
      const res = await listEnrollments({
        limit: PAGE_SIZE,
        cursor,
        boundary: boundaryFilter || undefined,
        active: activeFilter === '' ? undefined : activeFilter === 'active',
        custody: custodyFilter || undefined,
      })
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
    boundaryFilter =
      new URLSearchParams(router.querystring ?? '').get('boundary') ?? ''
    void loadMembers()
  })

  /** Re-run the listing from the first page under the current filters. */
  function reloadMembers() {
    members = []
    membersCursor = undefined
    membersTotal = undefined
    membersLoaded = false
    void loadMembers()
  }

  function applyBoundaryFilter(boundary: string) {
    boundaryFilter = boundary
    reloadMembers()
  }

  function applyActiveFilter(value: string) {
    if (value !== '' && value !== 'active' && value !== 'inactive') return
    activeFilter = value
    reloadMembers()
  }

  function applyCustodyFilter(value: string) {
    if (value !== '' && value !== 'stratos' && value !== 'pds') return
    custodyFilter = value
    reloadMembers()
  }

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
    const member = members.find((entry) => entry.did === did)
    detailCustody = member?.custody ?? null
    detailIsService = member?.isService ?? false
    hostResolutions = []
    hostError = null
    setInput = ''
    try {
      const res = await resolveEnrollments(did)
      loadedDid = res.did
      enrolled = res.enrolled
      boundaries = res.boundaries
      const [statusResult, hostResult] = await Promise.allSettled([
        getEnrollmentStatus(did),
        getRepoHost(did),
      ])
      status = statusResult.status === 'fulfilled' ? statusResult.value : null
      if (hostResult.status === 'fulfilled') {
        detailCustody = hostResult.value.custody
        detailIsService = hostResult.value.isService
        hostResolutions = hostResult.value.resolutions
      } else {
        hostError =
          hostResult.reason instanceof Error
            ? hostResult.reason.message
            : String(hostResult.reason)
      }
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
      if (res.pdsSync === 'deferred') {
        warning =
          'Boundaries saved here. The member\u2019s PDS enrollment record ' +
          'update is deferred and will be retried in the background.'
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

  async function toggleActive() {
    if (!loadedDid || busy) return
    const did = loadedDid
    const next = !(status?.active ?? true)
    error = null
    warning = null
    busy = true
    try {
      const res = await setActive(did, next)
      // Re-read rather than trusting local state: the row must show what was
      // committed, and `status` may not have loaded.
      status = await getEnrollmentStatus(did).catch(() =>
        status ? { ...status, active: res.active } : status,
      )
      members = members.map((member) =>
        member.did === did ? { ...member, active: res.active } : member,
      )
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function collapseHostResolutions(
    resolutions: RepoHostResolution[],
  ): RepoHostResolution | undefined {
    if (resolutions.length === 0) return undefined
    const [first] = resolutions
    if (!first.host || !first.source) return undefined
    return resolutions.every(
      (resolution) =>
        resolution.host === first.host && resolution.source === first.source,
    )
      ? first
      : undefined
  }

  const collapsedHost = $derived(collapseHostResolutions(hostResolutions))
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
      Search jumps straight to a member, including one the domain filter below
      excludes.
    </p>
  </Card>

  <Card testid="members-card">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 class="font-display text-lg italic">Members</h2>
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-2">
          <span class="text-sm text-muted">Space</span>
          <select
            class="pill cursor-pointer px-4 py-1.5 text-sm outline-none"
            data-testid="members-filter"
            onchange={(event) =>
              applyBoundaryFilter(
                (event.currentTarget as HTMLSelectElement).value,
              )}
            value={boundaryFilter}
          >
            <option value="">All spaces</option>
            {#if boundaryFilter && !domains.includes(boundaryFilter)}
              <!--
                A filter from the URL may name a domain no longer in the
                allowed list. Show it so the control cannot read "All domains"
                while a filter is applied.
              -->
              <option value={boundaryFilter}>
                {boundaryName(boundaryFilter)} (retired)
              </option>
            {/if}
            {#each domains as domain (domain)}
              <option value={domain}>{boundaryName(domain)}</option>
            {/each}
          </select>
        </label>
        <label class="flex items-center gap-2">
          <span class="text-sm text-muted">Status</span>
          <select
            class="pill cursor-pointer px-4 py-1.5 text-sm outline-none"
            data-testid="members-active-filter"
            onchange={(event) =>
              applyActiveFilter((event.currentTarget as HTMLSelectElement).value)}
            value={activeFilter}
          >
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="inactive">Deactivated</option>
          </select>
        </label>
        <label class="flex items-center gap-2">
          <span class="text-sm text-muted">Custody</span>
          <select
            class="pill cursor-pointer px-4 py-1.5 text-sm outline-none"
            data-testid="members-custody-filter"
            onchange={(event) =>
              applyCustodyFilter((event.currentTarget as HTMLSelectElement).value)}
            value={custodyFilter}
          >
            <option value="">All</option>
            <option value="stratos">Stratos</option>
            <option value="pds">PDS</option>
          </select>
        </label>
        <span class="text-sm text-muted" data-testid="members-total">
          {membersTotal !== undefined
            ? `${members.length} of ${membersTotal}`
            : `${members.length} shown`}
        </span>
      </div>
    </div>

    {#if membersError && members.length === 0}
      <div class="space-y-3" data-testid="members-error">
        <p class="text-error">Failed to load members: {membersError}</p>
        <Button
          disabled={membersLoading}
          onclick={() => loadMembers(membersCursor)}
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
        {activeFilter === 'inactive'
          ? 'No members are deactivated.'
          : boundaryFilter
            ? `No members hold ${boundaryName(boundaryFilter)}.`
            : 'No members are enrolled yet.'}
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
                    <Chip label="service" />
                  {:else}
                    <Chip label={member.custody} />
                  {/if}
                  <StatusDot
                    label={member.active ? 'active' : 'deactivated'}
                    ok={member.active}
                  />
                </div>
              </div>
              {#if member.boundaries.length > 0}
                <div class="mt-2 flex flex-wrap gap-1.5">
                  {#each member.boundaries as boundary (boundary)}
                    <Chip label={boundaryName(boundary)} />
                  {/each}
                </div>
              {/if}
            </button>
          </li>
        {/each}
      </ul>

      {#if membersError}
        <p class="mt-4 text-error" data-testid="members-error">
          Failed to load more members: {membersError}
        </p>
      {/if}

      {#if membersCursor}
        <div class="mt-4">
          <Button
            disabled={membersLoading}
            onclick={() => loadMembers(membersCursor)}
            testid="members-load-more"
            variant="secondary"
          >
            {membersLoading
              ? 'Loading…'
              : membersError
                ? 'Retry'
                : 'Load more'}
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
        <h2 class="font-sans text-lg font-semibold not-italic">
          <Identity did={loadedDid} testid="enrollment-identity" />
        </h2>
        <div class="flex flex-wrap items-center gap-6">
          <StatusDot label={enrolled ? 'enrolled' : 'not enrolled'} ok={enrolled} />
          {#if status?.enrolledAt}
            <span class="text-sm text-muted">
              since {new Date(status.enrolledAt).toLocaleString()}
            </span>
          {/if}
          {#if status?.active === false}
            <span class="text-sm text-error">deactivated</span>
          {/if}
          {#if enrolled}
            <Button
              disabled={busy}
              onclick={toggleActive}
              testid="toggle-active"
              variant={status?.active === false ? 'secondary' : 'danger'}
            >
              {status?.active === false ? 'Reactivate' : 'Deactivate'}
            </Button>
          {/if}
        </div>

        <div>
          <h3 class="mb-2 text-sm font-medium text-muted">Spaces</h3>
          {#if boundaries.length === 0}
            <p class="text-sm text-muted" data-testid="no-boundaries">
              No spaces assigned.
            </p>
          {:else}
            <div class="flex flex-wrap gap-2">
              {#each boundaries as boundary (boundary)}
                <Chip
                  label={boundaryName(boundary)}
                  onremove={busy ? undefined : () => handleRemove(boundary)}
                  removable
                  testid="boundary-chip"
                />
              {/each}
            </div>
          {/if}
        </div>

        {#if hostError}
          <p class="text-sm text-error" data-testid="repo-host-error">
            Failed to resolve repository host: {hostError}
          </p>
        {/if}

        {#if !detailIsService}
          {#if detailCustody === 'stratos'}
            <p class="text-sm text-muted" data-testid="repo-host-detail">
              Hosted by this service.
            </p>
          {:else if detailCustody === 'pds'}
            <div data-testid="repo-host-detail">
              <h3 class="mb-2 text-sm font-medium text-muted">Repository host</h3>
              {#if collapsedHost}
                <p class="text-sm text-muted">
                  {collapsedHost.host} ({collapsedHost.source})
                </p>
              {:else if hostResolutions.length === 0}
                <p class="text-sm text-muted">No spaces assigned.</p>
              {:else}
                <ul class="space-y-1 text-sm text-muted">
                  {#each hostResolutions as resolution (resolution.spaceUri)}
                    <li>
                      {boundaryName(resolution.boundary)}: {resolution.host
                        ? `${resolution.host} (${resolution.source})`
                        : 'Unresolved'}
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        {/if}

        {#if enrolled}
          <div class="flex items-end gap-3">
            <label class="block grow">
              <span class="mb-1 block text-sm font-medium text-muted">
                Add space
              </span>
              <select
                bind:value={selectedDomain}
                class="pill w-full cursor-pointer px-4 py-2 text-sm outline-none"
                data-testid="add-boundary-select"
              >
                <option value="">Select a space…</option>
                {#each availableDomains as domain (domain)}
                  <option value={domain}>{boundaryName(domain)}</option>
                {/each}
              </select>
            </label>
            <Button
              disabled={busy || !selectedDomain}
              onclick={handleAdd}
              testid="add-boundary"
            >
              Add space
            </Button>
          </div>

          <details class="rounded-2xl bg-background/40 p-3">
            <summary
              class="cursor-pointer text-sm font-medium text-muted select-none"
              data-testid="set-boundaries-toggle"
            >
              Set spaces
            </summary>
            <div class="mt-3 flex items-end gap-3">
              <div class="grow">
                <TextField
                  bind:value={setInput}
                  ariaLabel="Spaces, comma-separated"
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
            <p class="mt-2 text-xs text-muted">
              Replaces every space at once. Values are full domains, not short
              names.
            </p>
          </details>
        {/if}
      </div>
    </Card>
  {/if}
</div>

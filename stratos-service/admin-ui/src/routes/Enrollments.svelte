<script lang="ts">
  import {
    addBoundary,
    getEnrollmentStatus,
    listDomains,
    removeBoundary,
    resolveEnrollments,
    setBoundaries,
    type BoundariesResponse,
    type EnrollmentStatusResponse,
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

  async function search() {
    const query = searchDid.trim()
    if (!query) return
    error = null
    warning = null
    busy = true
    try {
      let did = query
      if (!did.startsWith('did:')) {
        const resolved = await resolveDid(did)
        if (!resolved) {
          throw new Error(`Could not resolve handle "${query}" to a DID`)
        }
        did = resolved
      }
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

  async function mutate(action: () => Promise<BoundariesResponse>) {
    error = null
    warning = null
    busy = true
    try {
      const res = await action()
      boundaries = res.boundaries
      setInput = res.boundaries.join(', ')
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
    if (!loadedDid || !selectedDomain) return
    const did = loadedDid
    const boundary = selectedDomain
    selectedDomain = ''
    void mutate(() => addBoundary(did, boundary))
  }

  function handleRemove(boundary: string) {
    if (!loadedDid) return
    const did = loadedDid
    void mutate(() => removeBoundary(did, boundary))
  }

  function handleSet() {
    if (!loadedDid) return
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
      There is no list-all-enrollments endpoint; look up members by DID or
      handle.
    </p>
  </Card>

  {#if error}
    <Card><p class="text-error" data-testid="enrollments-error">{error}</p></Card>
  {/if}

  {#if warning}
    <Card>
      <p class="text-purple dark:text-mint" data-testid="enrollments-warning">
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
                  onremove={() => handleRemove(boundary)}
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

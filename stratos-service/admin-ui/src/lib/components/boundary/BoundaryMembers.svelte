<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import {
    addBoundary,
    getEnrollmentStatus,
    getRepoHost,
    listEnrollments,
    removeBoundary,
    resolveEnrollments,
    type Custody,
    type EnrollmentSummary,
    type EnrollmentStatusResponse,
  } from '../../api/client'
  import { resolveDid } from '../../api/identity'
  import { listBoundaries, type BoundaryDetails } from '../../api/boundary-catalog'
  import {
    createMembershipPreview,
    getMembershipAvailability,
    membershipPreviewMatches,
    type MembershipOperation,
    type MembershipPreview,
    type MembershipSnapshot,
  } from '../../boundary-workspace'
  import Button from '../ui/Button.svelte'
  import Card from '../ui/Card.svelte'
  import Identity from '../ui/Identity.svelte'
  import TextField from '../ui/TextField.svelte'

  interface Props {
    boundary: BoundaryDetails
    onrefresh: () => Promise<void> | void
    uncertainMemberships: Set<string>
    pendingMemberships: Set<string>
    onMembershipPending: (did: string, boundary: string, pending: boolean) => void
    onUncertainMembership: (did: string, boundary: string, uncertain: boolean) => void
  }

  let { boundary, onrefresh, uncertainMemberships, pendingMemberships, onMembershipPending, onUncertainMembership }: Props = $props()
  const PAGE_SIZE = 25
  let listGeneration = 0
  let targetGeneration = 0
  let requestGeneration = 0
  let writeGeneration = 0
  let writeOwner: { generation: number; boundary: string; identity: number } | null = null
  function membershipKey(did: string, boundaryId: string) {
    return JSON.stringify([did, boundaryId])
  }

  const membershipIsUncertain = (did: string, boundaryId: string) => uncertainMemberships.has(membershipKey(did, boundaryId))
  const uncertainWrite = $derived(target !== null && membershipIsUncertain(target, boundary.boundary))
  const targetWritePending = $derived(target !== null && pendingMemberships.has(membershipKey(target, boundary.boundary)))
  let lookupToken = 0
  let reconciliationPending = $state(false)
  let writePending = $state(false)
  let confirmationPending = $state(false)
  let rows = $state<EnrollmentSummary[]>([])
  let cursor = $state<string | undefined>()
  let total = $state<number | undefined>()
  let loading = $state(false)
  let listError = $state<string | null>(null)
  let activeFilter = $state<'' | 'active' | 'inactive'>('')
  let custodyFilter = $state<'' | 'stratos' | 'pds'>('')
  let query = $state('')
  let target = $state<string | null>(null)
  let lookupIdentity = $state('')
  let enrolled = $state(false)
  let memberships = $state<string[]>([])
  let activation = $state<EnrollmentStatusResponse | null>(null)
  let detailLoading = $state(false)
  let detailError = $state<string | null>(null)
  let detailWarning = $state<string | null>(null)
  let custody = $state<Custody | null>(null)
  let isService = $state<boolean | null>(null)
  let preview = $state<MembershipPreview | null>(null)
  let previewSnapshot = $state<MembershipSnapshot | null>(null)
  const reconciling = $derived(uncertainWrite || reconciliationPending)
  const reconcilingIdentity = $derived(uncertainWrite ? target : null)
  let notice = $state<string | null>(null)
  let error = $state<string | null>(null)

  function currentTarget(g: number, boundaryId: string) {
    return g === targetGeneration && boundary.boundary === boundaryId
  }

  function currentList(g: number, boundaryId: string) {
    return g === listGeneration && boundary.boundary === boundaryId
  }

  function currentWrite(g: number, boundaryId: string) {
    return g === writeGeneration && boundary.boundary === boundaryId
  }

  async function loadPage(next?: string): Promise<boolean> {
    const g = listGeneration
    const boundaryId = boundary.boundary
    const pageRequest = ++requestGeneration
    loading = true
    listError = null
    try {
      const result = await listEnrollments({
        limit: PAGE_SIZE,
        cursor: next,
        boundary: boundaryId,
        active: activeFilter === '' ? undefined : activeFilter === 'active',
        custody: custodyFilter || undefined,
      })
      if (!currentList(g, boundaryId) || pageRequest !== requestGeneration) return false
      rows = next ? [...rows, ...result.enrollments] : result.enrollments
      cursor = result.cursor
      total = result.total
      return true
    } catch (err) {
      if (!currentList(g, boundaryId) || pageRequest !== requestGeneration) return false
      listError = message(err)
      return false
    } finally {
      if (currentList(g, boundaryId) && pageRequest === requestGeneration) loading = false
    }
  }

  function message(err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }

  function resetList() {
    listGeneration++
    requestGeneration++
    writeGeneration++
    writeOwner = null
    confirmationPending = false
    writePending = false
    targetGeneration++
    lookupToken++
    target = null
    lookupIdentity = ''
    memberships = []
    enrolled = false
    activation = null
    custody = null
    isService = null
    detailError = null
    detailWarning = null
    preview = null
    previewSnapshot = null
    notice = null
    error = null

    reconciliationPending = false
    detailLoading = false

    rows = []
    cursor = undefined
    total = undefined
    listError = null
    void loadPage()
  }

  const boundaryKey = $derived(
    `${boundary.boundary}:${boundary.revision}:${boundary.status}:${boundary.reserved}`,
  )

  $effect(() => {
    boundaryKey
    untrack(resetList)
  })

  onDestroy(() => {
    targetGeneration++
    listGeneration++
    writeGeneration++
    writeOwner = null
    requestGeneration++
  })

  function selectRow(row: EnrollmentSummary) {
    query = row.did
    void lookup(row.did)
  }

  async function lookup(input = query.trim()) {
    if (!input) return
    reconciliationPending = false
    writeGeneration++
    writeOwner = null
    confirmationPending = false
    writePending = false
    ++lookupToken
    const g = ++targetGeneration
    detailLoading = true
    const boundaryId = boundary.boundary
    const identity = input
    lookupIdentity = identity
    target = null
    memberships = []
    activation = null
    custody = null
    isService = null
    detailError = null
    detailWarning = null
    preview = null
    previewSnapshot = null
    detailLoading = true
    notice = null
    error = null
    let did = input
    try {
      if (!did.startsWith('did:')) {
        const resolved = await resolveDid(input)
        if (!currentTarget(g, boundaryId)) return
        if (!resolved) throw new Error(`Could not resolve handle “${input}” to a DID.`)
        did = resolved
      }
      const result = await resolveEnrollments(did)
      if (!currentTarget(g, boundaryId)) return
      target = result.did
      lookupIdentity = result.did
      enrolled = result.enrolled
      memberships = result.boundaries
      if (!result.enrolled) return
      const [statusResult, hostResult] = await Promise.allSettled([
        getEnrollmentStatus(result.did),
        getRepoHost(result.did),
      ])
      if (!currentTarget(g, boundaryId)) return
      activation = statusResult.status === 'fulfilled' ? statusResult.value : null
      if (statusResult.status === 'rejected') detailWarning = `Enrollment status is unknown: ${message(statusResult.reason)}`
      if (hostResult.status === 'fulfilled') {
        custody = hostResult.value.custody
        isService = hostResult.value.isService
      } else {
        detailWarning = [detailWarning, `Custody and service status are unknown: ${message(hostResult.reason)}`].filter(Boolean).join(' ')
      }
    } catch (err) {
      if (currentTarget(g, boundaryId)) detailError = message(err)
    } finally {
      if (currentTarget(g, boundaryId)) detailLoading = false
    }
  }

  function snapshot(): MembershipSnapshot | null {
    if (!target || !activation) return null
    return {
      lookupIdentity,
      boundary: {
        boundary: boundary.boundary,
        revision: boundary.revision,
        status: boundary.status,
        reserved: boundary.reserved,
      },
      enrollment: {
        did: target,
        enrolled,
        active: activation.active,
        boundaries: memberships,
        uncertainBoundaries: uncertainWrite ? [boundary.boundary] : [],
      },
    }
  }

  function review(operation: MembershipOperation) {
    preview = null
    previewSnapshot = null
    const state = snapshot()
    if (targetWritePending || uncertainWrite || writePending) return
    if (!state) {
      detailError = 'Reload enrollment status before reviewing a membership change.'
      return
    }
    const next = createMembershipPreview(operation, state)
    preview = next
    previewSnapshot = next ? state : null
    const availability = getMembershipAvailability(operation, state)
    if (!availability.available) detailWarning = unavailable(availability.reason)
  }

  function unavailable(reason: string) {
    const descriptions: Record<string, string> = {
      'target-mismatch': 'The resolved identity no longer matches this lookup.',
      unenrolled: 'This DID is not enrolled. Use Enrollments to manage enrollment; this page cannot create or invite accounts.',
      'already-member': 'This enrollment already belongs to this boundary.',
      'not-member': 'This enrollment is not a member of this boundary.',
      'reserved-boundary': 'The reserved all-members boundary cannot be changed here.',
      'boundary-not-active': 'Only active boundaries accept new memberships.',
      'reconciliation-required': 'Reconcile the previous write before reviewing another change.',
    }
    return descriptions[reason] ?? 'This membership change is unavailable.'
  }

  async function confirmChange() {
    if (confirmationPending || reconciling || uncertainWrite || targetWritePending || !preview || !target) return
    confirmationPending = true
    writePending = true
    const g = ++writeGeneration
    const chosen = preview
    const beforeConfirmation = previewSnapshot
    const boundaryId = boundary.boundary
    const identityToken = lookupToken
    writeOwner = { generation: g, boundary: boundaryId, identity: identityToken }
    detailError = null
    detailWarning = null
    preview = null
    previewSnapshot = null
    let writeAttempted = false
    try {
      const [enrollment, freshStatus, catalog] = await Promise.all([
        resolveEnrollments(chosen.targetDid),
        getEnrollmentStatus(chosen.targetDid),
        listBoundaries(),
      ])
      if (!currentWrite(g, boundaryId) || identityToken !== lookupToken) return
      if (chosen.targetDid !== target || chosen.lookupIdentity !== lookupIdentity) return
      const currentBoundary = catalog.boundaries.find((item) => item.boundary === boundaryId)
      const fresh: MembershipSnapshot = {
        lookupIdentity: chosen.lookupIdentity,
        boundary: currentBoundary
          ? { boundary: currentBoundary.boundary, revision: currentBoundary.revision, status: currentBoundary.status, reserved: currentBoundary.reserved }
          : { boundary: boundaryId, revision: -1, status: 'inactive', reserved: true },
        enrollment: {
          did: enrollment.did,
          enrolled: enrollment.enrolled,
          active: freshStatus.active,
          boundaries: enrollment.boundaries,
        },
      }
      if (!beforeConfirmation || !membershipPreviewMatches(chosen, beforeConfirmation)) {
        preview = null
        previewSnapshot = null
        detailWarning = 'The selected target or boundary changed. Review the current state before trying again.'
        return
      }
      if (!currentBoundary || !membershipPreviewMatches(chosen, fresh)) {
        preview = null
        previewSnapshot = null
        if (currentWrite(g, boundaryId)) {
          target = enrollment.did
          lookupIdentity = enrollment.did
          memberships = enrollment.boundaries
          enrolled = enrollment.enrolled
          activation = freshStatus
          detailWarning = 'Membership or boundary state changed. Review the current state before trying again.'
        }
        return
      }
      activation = freshStatus
      if (!currentWrite(g, boundaryId) || chosen.targetDid !== target) return
      writeAttempted = true
      onMembershipPending(chosen.targetDid, chosen.boundary, true)
      onUncertainMembership(chosen.targetDid, chosen.boundary, true)
      const result = chosen.operation.type === 'add'
        ? await addBoundary(chosen.targetDid, chosen.boundary)
        : await removeBoundary(chosen.targetDid, chosen.boundary)
      if (result.did === chosen.targetDid) onUncertainMembership(chosen.targetDid, chosen.boundary, false)
      if (!currentWrite(g, boundaryId) || identityToken !== lookupToken) return
      if (result.did !== chosen.targetDid || result.boundaries.includes(chosen.boundary) !== (chosen.operation.type === 'add')) {
        const isMember = result.boundaries.includes(chosen.boundary)
        memberships = result.boundaries
        notice = `The server response reports this membership is ${isMember ? 'present' : 'absent'}, not as requested. Refreshing current state.`
        await refreshAfterChange(g, boundaryId)
        return
      }
      memberships = result.boundaries
      notice = result.pdsSync === 'deferred'
        ? 'Membership saved locally. PDS publication is deferred and will be retried.'
        : 'Membership change saved.'
      await refreshAfterChange(g, boundaryId)
    } catch (err) {
      if (writeAttempted) {
        if (currentWrite(g, boundaryId) && identityToken === lookupToken) {
          preview = null
          previewSnapshot = null
        }
        onUncertainMembership(chosen.targetDid, chosen.boundary, true)
        if (currentWrite(g, boundaryId) && identityToken === lookupToken) {
          detailWarning = `The result is uncertain; its final state is unknown. Reconcile before another reviewed attempt. ${message(err)}`
        }
        if (currentWrite(g, boundaryId) && identityToken === lookupToken) {
          await refreshAfterChange(g, boundaryId, false, chosen.targetDid)
        }
      } else if (currentWrite(g, boundaryId) && identityToken === lookupToken) {
        preview = null
        previewSnapshot = null
        detailWarning = `Required fresh reads failed. No write was sent; reload enrollment and catalog, then review again. ${message(err)}`
      }
    } finally {
      if (writeAttempted) onMembershipPending(chosen.targetDid, chosen.boundary, false)
      if (writeOwner?.generation === g) {
        writeOwner = null
        if (currentWrite(g, boundaryId) && identityToken === lookupToken) {
          confirmationPending = false
          writePending = false
        }
      }
    }
  }

  async function refreshAfterChange(g: number, boundaryId: string, clearUncertainty = false, reconcileDid = target) {
    const selectedBoundaryId = boundary.boundary
    const selectedTargetGeneration = targetGeneration
    const listRefresh = loadPage()
    const selectedDid = reconcileDid
    const targetRefresh = selectedDid
      ? Promise.all([resolveEnrollments(selectedDid), getEnrollmentStatus(selectedDid)])
      : Promise.resolve(null)
    const catalogRefresh = Promise.resolve().then(async () => {
      await onrefresh()
      return listBoundaries()
    })
    const [listRefreshed, refreshedTarget, catalogResult] = await Promise.allSettled([
      listRefresh,
      targetRefresh,
      catalogRefresh,
    ])
    if (!currentWrite(g, boundaryId) || selectedTargetGeneration !== targetGeneration) return
    if (currentWrite(g, boundaryId)) {
      if (listRefreshed.status === 'rejected' || !listRefreshed.value) {
        detailWarning = [detailWarning, 'The membership may be saved, but the member list could not be refreshed.'].filter(Boolean).join(' ')
      }
    }
    const targetReconciled = refreshedTarget.status === 'fulfilled' && refreshedTarget.value !== null
    if (targetReconciled && selectedDid === target && currentWrite(g, boundaryId)) {
      const [enrollment, status] = refreshedTarget.value
      enrolled = enrollment.enrolled
      memberships = enrollment.boundaries
      activation = status
    } else if (currentWrite(g, boundaryId)) {
      detailWarning = [detailWarning, `The member could not be reconciled: ${refreshedTarget.status === 'rejected' ? message(refreshedTarget.reason) : 'No target selected.'}`].filter(Boolean).join(' ')
    }
    if (catalogResult.status === 'rejected' && currentWrite(g, boundaryId)) {
      detailWarning = [detailWarning, 'The catalog could not be refreshed.'].filter(Boolean).join(' ')
    }
    const reconcilingCurrentBoundary = selectedBoundaryId === boundary.boundary && boundaryId === selectedBoundaryId
    if (reconcilingCurrentBoundary && currentWrite(g, boundaryId)) {
      const requiredReadsSucceeded =
        targetReconciled &&
        catalogResult.status === 'fulfilled' &&
        listRefreshed.status === 'fulfilled' &&
        listRefreshed.value
      if (requiredReadsSucceeded) {
        if (clearUncertainty) {
          onUncertainMembership(selectedDid!, boundaryId, false)
          detailWarning = null
          notice = null
        }
        if (clearUncertainty && !membershipIsUncertain(selectedDid!, boundaryId)) {
          const isMember = refreshedTarget.value[0].boundaries.includes(boundaryId)
          notice = isMember
            ? 'Reconciliation confirms this membership is present.'
            : 'Reconciliation confirms this membership is absent.'
        }
        if (membershipIsUncertain(selectedDid!, boundaryId)) {
          notice = null
        }
      } else if (membershipIsUncertain(selectedDid!, boundaryId)) {
        detailWarning = [detailWarning, 'Reconciliation is incomplete. Retry after all required reads succeed.'].filter(Boolean).join(' ')
      }
    }
  }

  async function retryReconciliation() {
    if (reconciliationPending || targetWritePending || !reconcilingIdentity || !membershipIsUncertain(reconcilingIdentity, boundary.boundary)) return
    reconciliationPending = true
    notice = null
    const g = ++writeGeneration
    const identity = reconcilingIdentity
    const boundaryId = boundary.boundary

    try {
      await refreshAfterChange(g, boundaryId, true, identity)
    } finally {
      if (currentWrite(g, boundaryId)) reconciliationPending = false
    }
  }

  function filtersChanged() {
    resetList()
  }
</script>

<div class="space-y-5" data-testid="boundary-members">
  <section aria-label="Boundary members" class="space-y-3">
    <div class="flex flex-wrap items-end gap-3">
      <label class="text-sm">Enrollment status
        <select class="pill ml-2 px-3 py-2" bind:value={activeFilter} onchange={filtersChanged}>
          <option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option>
        </select>
      </label>
      <label class="text-sm">Custody
        <select class="pill ml-2 px-3 py-2" bind:value={custodyFilter} onchange={filtersChanged}>
          <option value="">All</option><option value="stratos">Stratos</option><option value="pds">PDS</option>
        </select>
      </label>
      <span class="text-sm text-muted">Catalog members: {boundary.memberCount}</span>
      <span class="text-sm text-muted">Loaded rows: {rows.length}</span>
      {#if total !== undefined}<span class="text-sm text-muted">Filtered total: {total}</span>{/if}
    </div>
    {#if listError}<p role="alert" class="text-sm text-error">{listError}</p>{/if}
    <ul class="space-y-2">
      {#each rows as row (row.did)}
        <li><button class="pill w-full p-3 text-left" aria-pressed={target === row.did} onclick={() => selectRow(row)}><Identity did={row.did} /> <span class="text-xs text-muted">{row.active ? 'Active' : 'Inactive'} · {row.custody} custody · {row.isService ? 'Service account' : 'Person'}</span></button></li>
      {/each}
    </ul>
    <div class="flex gap-2">
      {#if listError}<Button variant="secondary" onclick={() => loadPage(cursor)} disabled={loading}>Retry page</Button>{/if}
      {#if cursor}<Button variant="secondary" onclick={() => loadPage(cursor)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</Button>{/if}
      {#if !rows.length && loading}<p role="status" class="text-sm text-muted">Loading members…</p>{/if}
    </div>
  </section>

  <Card title="Find an enrollment" testid="boundary-member-lookup">
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-[16rem] flex-1"><TextField bind:value={query} label="DID or handle" placeholder="did:plc:… or rei.example" onenter={() => void lookup()} /></div>
      <Button onclick={() => void lookup()} >Look up</Button>
    </div>
    {#if detailLoading}<p role="status" class="mt-3 text-sm text-muted">Loading enrollment…</p>{/if}
    {#if detailError}<p role="alert" class="mt-3 text-sm text-error">{detailError}</p>{/if}
    {#if detailWarning}<p role="status" class="mt-3 text-sm text-muted">{detailWarning}</p>{/if}
    {#if reconcilingIdentity && membershipIsUncertain(reconcilingIdentity, boundary.boundary)}<Button variant="secondary" onclick={retryReconciliation} disabled={reconciliationPending || targetWritePending}>Retry reconciliation for {reconcilingIdentity}</Button>{/if}
    {#if target && !detailLoading}
      <div class="mt-4 space-y-2 border-t border-muted/20 pt-4">
        <p><strong>Target:</strong> <Identity did={target} /></p>
        <p><strong>Enrollment:</strong> {enrolled ? activation ? activation.active === false ? 'Inactive' : activation.active === true ? 'Active' : 'Unknown' : 'Unknown' : 'Not enrolled'}</p>
        <p><strong>This boundary:</strong> {memberships.includes(boundary.boundary) ? 'Member' : 'Not a member'}</p>
        {#if custody}<p><strong>Custody:</strong> {custody}</p>{/if}
        {#if isService !== null}<p><strong>Account:</strong> {isService ? 'Service account' : 'Person'}</p>{/if}
        {#if !enrolled}<p class="text-sm text-muted">This page cannot create or invite an enrollment. <a class="underline" href="#/enrollments">Open Enrollments</a>.</p>{:else}
          <div class="flex flex-wrap gap-2">
            {#if boundary.status === 'active'}<Button onclick={() => review({ type: 'add' })} disabled={detailLoading || writePending || targetWritePending || reconciling || uncertainWrite || !activation}>Add to this boundary</Button>{:else}<p class="text-sm text-muted">Only active boundaries accept new memberships.</p>{/if}
            <Button variant="danger" onclick={() => review({ type: 'remove' })} disabled={detailLoading || writePending || targetWritePending || reconciling || uncertainWrite || !activation}>Remove from this boundary</Button>
          </div>
        {/if}
      </div>
    {/if}
    {#if preview}
      <div class="mt-4 rounded-2xl bg-bubble p-4" data-testid="membership-preview">
        <h3 class="font-semibold">Review one membership change</h3>
        <p class="mt-2 break-all text-sm">{preview.operation.type === 'add' ? 'Add' : 'Remove'} {preview.targetDid} {preview.operation.type === 'add' ? 'to' : 'from'} {preview.boundary}</p>
        {#if preview.operation.type === 'add' && preview.active === false}<p class="mt-2 text-sm text-muted">This enrollment is inactive. Membership does not activate it.</p>{/if}
        {#if preview.operation.type === 'remove'}<p class="mt-2 text-sm text-muted">Removal is not a ban. Later authorized rejoin remains possible.</p>{/if}
        <p class="mt-2 text-sm text-muted">Other boundary memberships are unchanged. Membership APIs have no compare-and-swap; state can still change after revalidation.</p>
        <div class="mt-4 flex gap-2"><Button onclick={confirmChange} disabled={confirmationPending || reconciling}>Confirm change</Button><Button variant="secondary" onclick={() => { preview = null; previewSnapshot = null }} disabled={writePending}>Cancel</Button></div>
      </div>
    {/if}
    {#if notice}<p role="status" class="mt-3 text-sm">{notice}</p>{/if}
    {#if error}<p role="alert" class="mt-3 text-sm text-error">{error}</p>{/if}
  </Card>
</div>

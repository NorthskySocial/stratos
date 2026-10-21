<script lang="ts">
  import type { BoundaryDetails } from '../../api/boundary-catalog'
  import Card from '../ui/Card.svelte'

  interface Props {
    boundary: BoundaryDetails
  }

  let { boundary }: Props = $props()
</script>

<Card title="Configuration summary" testid="boundary-overview">
  <dl class="grid gap-4 sm:grid-cols-2">
    <div class="sm:col-span-2">
      <dt class="text-xs font-semibold uppercase tracking-wide text-muted">Description</dt>
      <dd class="mt-1 whitespace-pre-wrap break-words">{boundary.description || 'No description'}</dd>
    </div>
    <div>
      <dt class="text-xs font-semibold uppercase tracking-wide text-muted">Catalog members</dt>
      <dd class="mt-1">{boundary.memberCount}</dd>
    </div>
    <div>
      <dt class="text-xs font-semibold uppercase tracking-wide text-muted">Lifecycle</dt>
      <dd class="mt-1">{boundary.status === 'deactivating' ? 'Removing members' : boundary.status === 'active' ? 'Active' : 'Inactive'}</dd>
    </div>
    <div>
      <dt class="text-xs font-semibold uppercase tracking-wide text-muted">Directory listing</dt>
      <dd class="mt-1">{boundary.listed ? 'Publicly listed' : 'Unlisted'}</dd>
    </div>
    <div>
      <dt class="text-xs font-semibold uppercase tracking-wide text-muted">Joining</dt>
      <dd class="mt-1">{boundary.joinable ? 'Members may join' : 'Admin-managed membership'}</dd>
    </div>
    <div>
      <dt class="text-xs font-semibold uppercase tracking-wide text-muted">Automatic enrollment</dt>
      <dd class="mt-1">{boundary.autoEnroll ? 'Enabled' : 'Disabled'}</dd>
    </div>
    <div>
      <dt class="text-xs font-semibold uppercase tracking-wide text-muted">Application policy</dt>
      <dd class="mt-1 break-words">{boundary.appAccess === 'open' ? 'Any authorized app' : 'Allowlisted applications'}</dd>
    </div>
    {#if boundary.appAccess === 'allowList'}
      <div class="sm:col-span-2">
        <dt class="text-xs font-semibold uppercase tracking-wide text-muted">Allowed application IDs</dt>
        <dd class="mt-1 break-all">{boundary.clientIds.length ? boundary.clientIds.join(', ') : 'No applications listed'}</dd>
      </div>
    {/if}
  </dl>
  <div class="mt-6 space-y-2 border-t border-muted/20 pt-4 text-sm text-muted">
    <p>Directory listing does not make boundary content public.</p>
    <p>Closing joins does not remove existing members.</p>
    <p>An application allowance does not grant boundary membership.</p>
    <p>Feed configuration and service membership are separate tasks.</p>
  </div>
</Card>

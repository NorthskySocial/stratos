<script lang="ts">
  import { listDomains } from '../lib/api/client'
  import Card from '../lib/components/ui/Card.svelte'
  import Chip from '../lib/components/ui/Chip.svelte'

  let domains = $state<string[] | null>(null)
  let error = $state<string | null>(null)

  $effect(() => {
    listDomains()
      .then((res) => (domains = res.domains))
      .catch((err: Error) => (error = err.message))
  })
</script>

<div class="space-y-6" data-testid="domains-screen">
  <h1 class="font-display text-2xl font-semibold">Domains</h1>

  <Card title="Allowed boundary domains">
    {#if error}
      <p class="text-error">Failed to load domains: {error}</p>
    {:else if !domains}
      <p class="text-muted">Loading…</p>
    {:else if domains.length === 0}
      <p class="text-muted">No domains configured.</p>
    {:else}
      <div class="flex flex-wrap gap-2">
        {#each domains as domain (domain)}
          <Chip label={domain} testid="domain-chip" />
        {/each}
      </div>
    {/if}
  </Card>
</div>

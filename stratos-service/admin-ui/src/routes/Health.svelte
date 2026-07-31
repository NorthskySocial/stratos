<script lang="ts">
  import { getHealth, type HealthResponse } from '../lib/api/client'
  import Card from '../lib/components/ui/Card.svelte'
  import StatusDot from '../lib/components/ui/StatusDot.svelte'

  let health = $state<HealthResponse | null>(null)
  let error = $state<string | null>(null)

  $effect(() => {
    getHealth()
      .then((res) => (health = res))
      .catch((err: Error) => (error = err.message))
  })
</script>

<div class="space-y-6" data-testid="health-screen">
  <h1 class="font-display text-2xl font-semibold">Service Health</h1>

  {#if error}
    <Card><p class="text-error">Failed to load health: {error}</p></Card>
  {:else if !health}
    <Card><p class="text-muted">Loading…</p></Card>
  {:else}
    <Card title="Overall">
      <div class="flex items-center justify-between">
        <StatusDot label={health.status} ok={health.status === 'ok'} />
        {#if health.version}
          <span class="text-sm text-muted">v{health.version}</span>
        {/if}
      </div>
    </Card>
    {#if health.components}
      <Card title="Components">
        <ul class="space-y-2">
          {#each Object.entries(health.components) as [name, status] (name)}
            <li class="flex items-center justify-between">
              <span class="text-sm">{name}</span>
              <StatusDot label={status} ok={status === 'ok'} />
            </li>
          {/each}
        </ul>
      </Card>
    {/if}
  {/if}
</div>

<script lang="ts">
  import { resolveHandle } from '../../api/identity'

  interface Props {
    did: string
    testid?: string
  }

  let { did, testid }: Props = $props()
  let handle = $state<string | null>(null)

  $effect(() => {
    handle = null
    const current = did
    void resolveHandle(current)
      .then((resolved) => {
        if (did === current) handle = resolved
      })
      .catch(() => {
        // Resolution is best-effort; the raw DID stays on screen.
      })
  })
</script>

<span class="inline-flex flex-wrap items-baseline gap-x-2" data-testid={testid}>
  {#if handle}
    <span class="font-semibold">@{handle}</span>
    <span class="text-xs text-muted">{did}</span>
  {:else}
    <span>{did}</span>
  {/if}
</span>

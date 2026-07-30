<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    children: Snippet
  }

  let { children }: Props = $props()
</script>

<h1 class="font-display text-3xl font-semibold italic">
  <span class="text-gradient">{@render children()}</span>
</h1>

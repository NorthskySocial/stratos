<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    title?: string
    testid?: string
    children: Snippet
  }

  let { title, testid, children }: Props = $props()
</script>

<section
  class="rounded-[2rem] bg-surface p-6 shadow-brand sm:p-8"
  data-testid={testid}
>
  {#if title}
    <h2 class="mb-4 font-display text-lg italic">{title}</h2>
  {/if}
  {@render children()}
</section>

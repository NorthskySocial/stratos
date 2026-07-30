<script lang="ts">
  interface Props {
    ok: boolean
    label?: string
  }

  let { ok, label }: Props = $props()
</script>

<span class="inline-flex items-center gap-2 text-sm">
  <span
    class="inline-block h-2.5 w-2.5 rounded-full {ok
      ? 'bg-mint'
      : 'bg-error'}"
  ></span>
  {#if label}{label}{/if}
</span>

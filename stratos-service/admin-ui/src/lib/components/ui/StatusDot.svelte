<script lang="ts">
  interface Props {
    ok: boolean
    label?: string
  }

  let { ok, label }: Props = $props()
</script>

<span class="inline-flex items-center gap-2 text-sm">
  <span
    aria-label={label ? undefined : ok ? 'OK' : 'Error'}
    class="inline-block h-2.5 w-2.5 rounded-full {ok
      ? 'bg-mint'
      : 'bg-error'}"
    role="img"
  ></span>
  {#if label}{label}{/if}
</span>

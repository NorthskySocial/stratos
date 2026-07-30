<script lang="ts">
  interface Props {
    label: string
    removable?: boolean
    testid?: string
    onremove?: () => void
  }

  let { label, removable = false, testid, onremove }: Props = $props()
</script>

<span
  class="grad-fill inline-flex items-center gap-1 px-4 py-1.5 text-xs font-semibold"
  data-testid={testid}
>
  {label}
  {#if removable}
    <button
      aria-label="Remove {label}"
      class="squish ml-1 cursor-pointer rounded-full border-none bg-transparent px-1 text-white/80 hover:text-white"
      data-testid={testid ? `${testid}-remove` : undefined}
      onclick={onremove}
      type="button"
    >
      &times;
    </button>
  {/if}
</span>

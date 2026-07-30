<script lang="ts">
  interface Props {
    value: string
    placeholder?: string
    label?: string
    /** Accessible name when no visible label is rendered. */
    ariaLabel?: string
    testid?: string
    onenter?: () => void
  }

  let {
    value = $bindable(),
    placeholder = '',
    label,
    ariaLabel,
    testid,
    onenter,
  }: Props = $props()

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') onenter?.()
  }
</script>

<label class="block">
  {#if label}
    <span class="mb-1 block text-sm font-medium text-muted">{label}</span>
  {/if}
  <input
    bind:value
    aria-label={label ? undefined : ariaLabel}
    class="pill w-full px-5 py-2.5 text-sm outline-none focus:shadow-brand-pop"
    data-testid={testid}
    onkeydown={handleKeydown}
    {placeholder}
    type="text"
  />
</label>

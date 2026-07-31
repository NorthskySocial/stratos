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
  <!--
    Autofill is disabled deliberately: every field here takes an identifier
    (a DID, a handle, a boundary), never personal data, and a browser-supplied
    value in a field that grants admin access or rewrites boundaries is a
    silent way to act on the wrong subject.
  -->
  <input
    bind:value
    aria-label={label ? undefined : ariaLabel}
    autocapitalize="off"
    autocomplete="off"
    autocorrect="off"
    class="pill w-full px-5 py-2.5 text-sm outline-none focus:shadow-brand-pop"
    data-1p-ignore
    data-lpignore="true"
    data-testid={testid}
    onkeydown={handleKeydown}
    {placeholder}
    spellcheck="false"
    type="text"
  />
</label>

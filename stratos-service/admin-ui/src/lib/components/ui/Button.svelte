<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    variant?: 'primary' | 'secondary' | 'danger'
    type?: 'button' | 'submit'
    disabled?: boolean
    testid?: string
    onclick?: (event: MouseEvent) => void
    children: Snippet
  }

  let {
    variant = 'primary',
    type = 'button',
    disabled = false,
    testid,
    onclick,
    children,
  }: Props = $props()

  const variants: Record<string, string> = {
    primary: 'grad-fill font-bold disabled:opacity-50 disabled:shadow-none',
    secondary: 'pill font-semibold disabled:opacity-50',
    danger:
      'rounded-full border-none bg-error font-bold text-white shadow-brand disabled:opacity-50',
  }
</script>

<button
  class="squish cursor-pointer px-5 py-2 text-sm disabled:cursor-not-allowed {variants[
    variant
  ]}"
  data-testid={testid}
  {disabled}
  {onclick}
  {type}
>
  {@render children()}
</button>

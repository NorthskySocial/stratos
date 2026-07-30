<script lang="ts">
  import { theme, toggleTheme } from '../../stores/theme.svelte'
</script>

<button
  aria-label="Toggle theme"
  class="pill squish cursor-pointer px-3 py-1 text-sm"
  data-testid="theme-toggle"
  onclick={toggleTheme}
  type="button"
>
  {theme.dark ? '🌞' : '🌙'}
</button>

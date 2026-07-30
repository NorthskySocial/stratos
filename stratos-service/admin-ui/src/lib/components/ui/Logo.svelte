<script lang="ts">
  import { theme } from '../../stores/theme.svelte'
  import logoBtext from '../../../assets/logo/Northsky-Horizontal-Color_Btext.svg'
  import logoWtext from '../../../assets/logo/Northsky-Horizontal-Color_Wtext.svg'
</script>

<img
  alt="Northsky"
  class="h-8 select-none"
  data-testid="logo"
  src={theme.dark ? logoWtext : logoBtext}
/>

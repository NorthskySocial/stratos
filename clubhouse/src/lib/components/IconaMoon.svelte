<script lang="ts">
  import checkIcon from '../icons/check.svg'
  import closeIcon from '../icons/close.svg'
  import informationIcon from '../icons/information-circle.svg'

  interface Props {
    name: 'check' | 'close' | 'information'
    label?: string
  }

  // Local artwork is copied from the IconaMoon Light Interface set.
  let { name, label = '' }: Props = $props()
  const icons = {
    check: checkIcon,
    close: closeIcon,
    information: informationIcon,
  }
</script>

<img class="icon" src={icons[name]} alt={label} aria-hidden={label ? undefined : 'true'} />

<style>
  .icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: 0 0 auto;
  }
</style>

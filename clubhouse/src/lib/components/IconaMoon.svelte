<script lang="ts">
  import checkIcon from '../icons/check.svg'
  import categoryIcon from '../icons/category.svg'
  import closeIcon from '../icons/close.svg'
  import homeIcon from '../icons/home.svg'
  import informationIcon from '../icons/information-circle.svg'

  interface Props {
    name: 'category' | 'check' | 'close' | 'home' | 'information'
    label?: string
  }

  // Local artwork is copied from the IconaMoon Light Interface set.
  let { name, label = '' }: Props = $props()
  const icons = {
    category: categoryIcon,
    check: checkIcon,
    close: closeIcon,
    home: homeIcon,
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

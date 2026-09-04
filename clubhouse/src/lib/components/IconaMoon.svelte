<script lang="ts">
  import arrowLeftIcon from '../icons/arrow-left.svg'
  import bookmarkIcon from '../icons/bookmark.svg'
  import cameraIcon from '../icons/camera.svg'
  import checkIcon from '../icons/check.svg'
  import categoryIcon from '../icons/category.svg'
  import clockIcon from '../icons/clock.svg'
  import closeIcon from '../icons/close.svg'
  import commentIcon from '../icons/comment.svg'
  import giftIcon from '../icons/gift.svg'
  import heartIcon from '../icons/heart.svg'
  import homeIcon from '../icons/home.svg'
  import informationIcon from '../icons/information-circle.svg'
  import lightningIcon from '../icons/lightning.svg'
  import musicIcon from '../icons/music.svg'
  import shieldIcon from '../icons/shield.svg'
  import starIcon from '../icons/star.svg'
  import type { IconaMoonName } from '../icon-names'

  interface Props {
    name: IconaMoonName
    label?: string
  }

  let { name, label = '' }: Props = $props()
  const icons = {
    'arrow-left': arrowLeftIcon,
    bookmark: bookmarkIcon,
    camera: cameraIcon,
    category: categoryIcon,
    check: checkIcon,
    clock: clockIcon,
    close: closeIcon,
    comment: commentIcon,
    gift: giftIcon,
    heart: heartIcon,
    home: homeIcon,
    information: informationIcon,
    lightning: lightningIcon,
    music: musicIcon,
    shield: shieldIcon,
    star: starIcon,
  } satisfies Record<IconaMoonName, string>
</script>

<span
  class="icon"
  style:--icon-source={`url("${icons[name]}")`}
  role={label ? 'img' : undefined}
  aria-label={label || undefined}
  aria-hidden={label ? undefined : 'true'}
></span>

<style>
  .icon {
    display: inline-block;
    width: 1.25rem;
    height: 1.25rem;
    flex: 0 0 auto;
    background: currentColor;
    -webkit-mask: var(--icon-source) center / contain no-repeat;
    mask: var(--icon-source) center / contain no-repeat;
  }
</style>

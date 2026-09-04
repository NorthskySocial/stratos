<script lang="ts">
  import type { ClubhouseFeedPost } from '../feedgen'

  interface Props {
    author: ClubhouseFeedPost['author']
  }

  let { author }: Props = $props()
  const label = $derived(author.displayName ?? author.handle ?? author.did)
  const secondary = $derived(author.displayName && author.handle ? `@${author.handle}` : '')
</script>

<div class="post-author">
  {#if author.avatar}
    <img src={author.avatar} alt="" loading="lazy" referrerpolicy="no-referrer" />
  {:else}
    <span class="avatar-fallback" aria-hidden="true">{label[0]}</span>
  {/if}
  <span class="post-author-copy"><strong>{label}</strong>{#if secondary}<small>{secondary}</small>{/if}</span>
</div>

<script lang="ts">
  import type { FeedPost } from './feed'
  import PostCard from './PostCard.svelte'

  interface Props {
    posts: FeedPost[]
    loading: boolean
  }

  let { posts, loading }: Props = $props()
</script>

<div class="feed">
  {#if loading}
    <div class="loading">Loading posts…</div>
  {:else if posts.length === 0}
    <div class="empty">No posts yet. Create your first post above!</div>
  {:else}
    {#each posts as post (post.uri)}
      <PostCard {post} />
    {/each}
  {/if}
</div>

<style>
  .feed {
    flex: 1;
    overflow-y: auto;
  }

  .loading,
  .empty {
    padding: 2rem;
    text-align: center;
    color: #888;
    font-size: 0.9rem;
  }
</style>

<script lang="ts">
  import { groupIntoThreads, type FeedPost, type ThreadNode } from './feed'
  import PostCard from './PostCard.svelte'

  interface Props {
    posts: FeedPost[]
    loading: boolean
    onreply: (post: FeedPost) => void
  }

  let { posts, loading, onreply }: Props = $props()

  let threads = $derived(groupIntoThreads(posts))
</script>

{#snippet threadNode(node: ThreadNode)}
  <div
    class="thread-node"
    class:reply={node.depth > 0}
    class:shade-even={node.depth > 0 && node.depth % 2 === 0}
    class:shade-odd={node.depth > 0 && node.depth % 2 === 1}
    style="--depth: {Math.min(node.depth, 4)}"
  >
    {#if node.depth > 0}
      <div class="thread-line"></div>
    {/if}
    <PostCard post={node.post} {onreply} />
  </div>
  {#each node.replies as child (child.post.uri)}
    {@render threadNode(child)}
  {/each}
{/snippet}

<div class="feed">
  {#if loading}
    <div class="loading">Loading posts…</div>
  {:else if posts.length === 0}
    <div class="empty">No posts yet. Create your first post above!</div>
  {:else}
    {#each threads as node (node.post.uri)}
      <div class="thread-group">
        {@render threadNode(node)}
      </div>
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

  .thread-group {
    border-bottom: 1px solid #eee;
  }

  .thread-node {
    position: relative;
    padding-left: calc(var(--depth) * 1.5rem);
  }

  .thread-node.reply {
    border-top: none;
  }

  .thread-node.shade-odd {
    background: #f7f7f8;
  }

  .thread-node.shade-even {
    background: #efeff1;
  }

  .thread-node.shade-odd :global(.post-card.private) {
    background: #f5f0fa;
  }

  .thread-node.shade-even :global(.post-card.private) {
    background: #ece5f5;
  }

  .thread-line {
    position: absolute;
    left: calc(var(--depth) * 1.5rem - 0.75rem);
    top: 0;
    bottom: 0;
    width: 2px;
    background: #e0e0e0;
  }

  .thread-node.reply :global(.post-card) {
    border-bottom: none;
  }
</style>

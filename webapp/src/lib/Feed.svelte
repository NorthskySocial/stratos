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
  <div class="feed-header">~*~ My BLaHg ~*~</div>

  {#if loading}
    <div class="loading">
      <span class="bounce">.</span><span class="bounce b2">.</span><span class="bounce b3">.</span>
      lOaDiNg pOsTs
      <span class="bounce b4">.</span><span class="bounce b5">.</span><span class="bounce b6">.</span>
    </div>
  {:else if posts.length === 0}
    <div class="empty">
      <div class="empty-icon">📝</div>
      nO pOsTs yEt!! aDd sOmE xD
    </div>
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
    padding: 0.5rem;
  }

  .feed-header {
    text-align: center;
    font-size: 1.1rem;
    font-weight: bold;
    color: #ff69b4;
    text-shadow: 0 0 10px #ff69b4, 0 0 20px #ff00ff;
    margin-bottom: 0.75rem;
    padding: 0.4rem;
    border: 2px dashed #ff00ff44;
    border-radius: 8px;
    background: #ff00ff08;
    animation: rainbow 6s linear infinite;
  }

  .loading {
    padding: 2rem;
    text-align: center;
    color: #00ffff;
    font-size: 0.85rem;
    text-shadow: 0 0 6px #00ffff;
  }

  .bounce {
    display: inline-block;
    animation: bounce-dot 1.4s infinite;
  }
  .b2 { animation-delay: 0.1s; }
  .b3 { animation-delay: 0.2s; }
  .b4 { animation-delay: 0.3s; }
  .b5 { animation-delay: 0.4s; }
  .b6 { animation-delay: 0.5s; }

  .empty {
    padding: 2rem;
    text-align: center;
    color: #ffff00;
    font-size: 0.9rem;
    text-shadow: 0 0 6px #ffff0066;
  }

  .empty-icon {
    font-size: 2rem;
    margin-bottom: 0.5rem;
    animation: float 2s ease-in-out infinite;
  }

  @keyframes bounce-dot {
    0%, 80%, 100% { transform: translateY(0); }
    40% { transform: translateY(-6px); }
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-5px); }
  }

  @keyframes rainbow {
    0% { color: #ff0000; }
    16% { color: #ff8800; }
    33% { color: #ffff00; }
    50% { color: #00ff00; }
    66% { color: #0088ff; }
    83% { color: #ff00ff; }
    100% { color: #ff0000; }
  }
</style>

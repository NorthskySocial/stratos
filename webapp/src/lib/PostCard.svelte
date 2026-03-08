<script lang="ts">
  import type { FeedPost } from './feed'

  interface Props {
    post: FeedPost
  }

  let { post }: Props = $props()

  function formatTime(iso: string): string {
    try {
      const d = new Date(iso)
      const now = new Date()
      const diffMs = now.getTime() - d.getTime()
      const diffMin = Math.floor(diffMs / 60000)
      if (diffMin < 1) return 'just now'
      if (diffMin < 60) return `${diffMin}m`
      const diffHr = Math.floor(diffMin / 60)
      if (diffHr < 24) return `${diffHr}h`
      const diffDays = Math.floor(diffHr / 24)
      if (diffDays < 7) return `${diffDays}d`
      return d.toLocaleDateString()
    } catch {
      return ''
    }
  }
</script>

<article class="post-card" class:private={post.isPrivate}>
  {#if post.isPrivate}
    <span class="private-badge">✧ pRiVaTe ✧</span>
  {/if}

  {#if post.hasReply}
    <div class="reply-indicator">↩ rEpLy</div>
  {/if}

  <p class="post-text">{post.text}</p>

  {#if post.images.length > 0}
    <div class="image-grid" class:single={post.images.length === 1}>
      {#each post.images as img}
        <a href={img.fullsize} target="_blank" rel="noopener noreferrer" class="image-link">
          <img src={img.thumb} alt={img.alt} loading="lazy" />
        </a>
      {/each}
    </div>
  {/if}

  <div class="post-meta">
    <time>posted @ {formatTime(post.createdAt)} lol</time>
  </div>

  <div class="star-divider">✦ ✧ ✦ ✧ ✦</div>
</article>

<style>
  .post-card {
    padding: 0.75rem;
    margin-bottom: 0.5rem;
    border: 2px solid #00ffff44;
    border-radius: 8px;
    background: linear-gradient(135deg, #0a002088, #1a003088);
    position: relative;
    box-shadow: 0 0 8px #00ffff22;
  }

  .post-card.private {
    border-color: #ff00ff66;
    box-shadow: 0 0 12px #ff00ff33;
  }

  .private-badge {
    display: inline-block;
    background: linear-gradient(135deg, #ff00ff, #8b00ff);
    color: white;
    font-size: 0.65rem;
    font-weight: bold;
    padding: 0.15rem 0.5rem;
    border-radius: 10px;
    margin-bottom: 0.35rem;
    text-shadow: 0 0 4px #fff;
    animation: neon-pulse 2s ease-in-out infinite;
  }

  .reply-indicator {
    color: #00ffff;
    font-size: 0.7rem;
    margin-bottom: 0.3rem;
  }

  .post-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
    color: #eee;
    font-size: 0.85rem;
  }

  .image-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }

  .image-grid.single {
    grid-template-columns: 1fr;
  }

  .image-link {
    display: block;
    border: 2px solid #ff69b4;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 0 8px #ff69b488;
    transition: box-shadow 0.2s;
  }

  .image-link:hover {
    box-shadow: 0 0 16px #ff69b4, 0 0 24px #ff00ff88;
  }

  .image-link img {
    width: 100%;
    height: auto;
    display: block;
    max-height: 200px;
    object-fit: cover;
  }

  .post-meta {
    margin-top: 0.4rem;
    font-size: 0.7rem;
    color: #888;
    font-style: italic;
  }

  .star-divider {
    text-align: center;
    color: #ff69b444;
    font-size: 0.6rem;
    margin-top: 0.4rem;
    letter-spacing: 0.3em;
  }

  @keyframes neon-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }
</style>

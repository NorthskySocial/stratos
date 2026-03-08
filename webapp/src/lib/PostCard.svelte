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
    <span class="private-badge">Private</span>
  {/if}

  {#if post.hasReply}
    <div class="reply-indicator">Reply</div>
  {/if}

  <p class="post-text">{post.text}</p>

  <div class="post-meta">
    <time>{formatTime(post.createdAt)}</time>
  </div>
</article>

<style>
  .post-card {
    padding: 1rem;
    border-bottom: 1px solid #eee;
    position: relative;
  }

  .post-card.private {
    border-left: 3px solid #8b5cf6;
    background: #faf5ff;
  }

  .private-badge {
    display: inline-block;
    background: #8b5cf6;
    color: white;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    margin-bottom: 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .reply-indicator {
    color: #888;
    font-size: 0.8rem;
    margin-bottom: 0.3rem;
  }

  .post-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
  }

  .post-meta {
    margin-top: 0.5rem;
    font-size: 0.8rem;
    color: #888;
  }
</style>

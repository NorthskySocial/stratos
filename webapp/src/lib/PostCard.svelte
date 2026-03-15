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

  function shortDid(did: string): string {
    if (did.length <= 24) return did
    return did.slice(0, 16) + '…' + did.slice(-6)
  }
</script>

<article class="post-card" class:private={post.isPrivate}>
  <div class="post-header">
    <span class="author">
      @{post.authorHandle || shortDid(post.author)}
    </span>
    <time>{formatTime(post.createdAt)}</time>
  </div>

  <div class="badges">
    {#if post.isPrivate}
      <span class="private-badge">Private</span>
    {/if}
    {#each post.boundaries as domain}
      <span class="domain-badge">{domain}</span>
    {/each}
    {#if post.hasReply}
      <span class="reply-badge">Reply</span>
    {/if}
  </div>

  <p class="post-text">{post.text}</p>
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

  .post-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.35rem;
  }

  .author {
    font-weight: 600;
    font-size: 0.88rem;
    color: #333;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 70%;
  }

  .post-header time {
    font-size: 0.8rem;
    color: #888;
    flex-shrink: 0;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 0.4rem;
  }

  .private-badge {
    display: inline-block;
    background: #8b5cf6;
    color: white;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .domain-badge {
    display: inline-block;
    background: #e0e7ff;
    color: #3730a3;
    font-size: 0.7rem;
    font-weight: 500;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
  }

  .reply-badge {
    display: inline-block;
    background: #f3f4f6;
    color: #6b7280;
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
  }

  .post-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
  }
</style>

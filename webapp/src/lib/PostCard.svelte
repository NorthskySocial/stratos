<script lang="ts">
  import {Agent} from '@atproto/api'
  import type {FeedPost} from './feed'
  import {displayBoundary} from './boundary-display'
  import RecordInspector from './RecordInspector.svelte'
  import {getCid, type StratosImage} from './utils/cid'

  interface Props {
    post: FeedPost
    stratosAgent: Agent | null
    publicAgent?: Agent | null
    onreply: (post: FeedPost) => void
  }

  let {post, stratosAgent, publicAgent, onreply}: Props = $props()

  let inspectorOpen = $state(false)
  let imageUrls = $state<Record<string, string>>({})

  /**
   * Get the URL for an image.
   * @param img - The image object.
   * @returns The URL for the image or an empty string if not found.
   */
  function getImageUrl(img: StratosImage): string {
    const cid = getCid(img.image)
    if (cid && imageUrls[cid]) {
      return imageUrls[cid]
    }
    // If hydrated fields are available, use them
    if (img.thumb) {
      return img.thumb
    }
    if (img.fullsize) {
      return img.fullsize
    }
    if (typeof img.image === 'object' && img.image.url) {
      return img.image.url
    }
    return ''
  }

  $effect(() => {
    const embed = post.embed
    if (!embed) {
      return
    }

    /**
     * Recursively handle embedded records and images.
     * @param e - The embedded record or image.
     */
    const handleEmbed = (e: Record<string, unknown> | null | undefined) => {
      if (!e) {
        return
      }
      if (e.$type === 'app.bsky.embed.images' || e.$type === 'zone.stratos.embed.images' || e.images) {
        const images = (e.images as StratosImage[]) || []
        images.forEach((img) => {
          const imageObj = img.image || img
          const hasHydrated = img.thumb || img.fullsize || (typeof imageObj === 'object' && imageObj && 'url' in imageObj && imageObj.url)
          // Only load if we don't already have a hydrated URL
          if (!hasHydrated) {
            loadBlob(imageObj as StratosImage['image'])
          }
        })
      } else if (e.image) {
        const img = e as unknown as StratosImage
        const imageObj = img.image || img
        const hasHydrated = img.thumb || img.fullsize || (typeof imageObj === 'object' && imageObj && 'url' in imageObj && imageObj.url)
        if (!hasHydrated) {
          loadBlob(imageObj as StratosImage['image'])
        }
      } else if (e.$type === 'app.bsky.embed.external' || e.external) {
        const external = (e.external || e) as { thumb?: StratosImage['image']; uri?: string }
        if (external.thumb) {
          loadBlob(external.thumb)
        }
      } else if ((e.$type === 'app.bsky.embed.recordWithMedia' || e.media) && (e.media || e.record)) {
        handleEmbed((e.media || e.record) as Record<string, unknown>)
      }
    }

    handleEmbed(embed)

    return () => {
      // Clean up object URLs
      Object.values(imageUrls).forEach((url) => {
        if (typeof url === 'string' && url.startsWith('blob:')) {
          URL.revokeObjectURL(url)
        }
      })
    }
  })

  /**
   * Load a blob from the given image object.
   * @param image - The image object.
   */
  async function loadBlob(image: StratosImage['image']) {
    const cid = getCid(image)
    if (!cid || imageUrls[cid]) {
      return
    }

    try {
      let resp: { data: Uint8Array } | null = null
      const agent = stratosAgent
      if (post.isPrivate && agent) {
        try {
          // Use Stratos-specific getBlob for private posts
          console.log('Using Stratos getBlob for private post')
          const response = await agent.call('zone.stratos.sync.getBlob', {
            did: post.author,
            cid: cid
          })
          if (response?.data) {
            resp = {data: response.data as Uint8Array}
          }
        } catch (e) {
          // Fallback to standard getBlob
          resp = await agent.api.com.atproto.sync.getBlob({
            did: post.author,
            cid: cid,
          })
        }
      } else if (!post.isPrivate && publicAgent) {
        resp = await publicAgent.api.com.atproto.sync.getBlob({
          did: post.author,
          cid: cid,
        })
      } else if (!post.isPrivate) {
        // Fallback for public posts if no agent is available
        imageUrls[cid] = `https://bsky.social/xrpc/com.atproto.sync.getBlob?did=${post.author}&cid=${cid}`
        return
      }

      if (resp?.data) {
        const imageObj = image as Record<string, unknown>
        const mimeType =
          (typeof image !== 'string' &&
            (image?.mimeType ||
              (imageObj?.original as { mimeType?: string })?.mimeType ||
              (imageObj?.image as { mimeType?: string })?.mimeType)) ||
          'image/jpeg'
        const blob = new Blob([resp.data.buffer as ArrayBuffer], {type: mimeType})
        imageUrls[cid] = URL.createObjectURL(blob)
      }
    } catch {
      if (!post.isPrivate) {
        imageUrls[cid] = `https://bsky.social/xrpc/com.atproto.sync.getBlob?did=${post.author}&cid=${cid}`
      }
    }
  }

  /**
   * Format a time string to a human-readable format.
   * @param iso - The ISO 8601 time string.
   * @returns The formatted time string.
   */
  function formatTime(iso: string): string {
    if (!iso) {
      return ''
    }
    try {
      const d = new Date(iso)
      const now = new Date()
      const diffMs = now.getTime() - d.getTime()
      const diffMin = Math.floor(diffMs / 60000)
      if (diffMin < 1) {
        return 'just now'
      }
      if (diffMin < 60) {
        return `${diffMin}m`
      }
      const diffHr = Math.floor(diffMin / 60)
      if (diffHr < 24) {
        return `${diffHr}h`
      }
      const diffDays = Math.floor(diffHr / 24)
      if (diffDays < 7) {
        return `${diffDays}d`
      }
      return d.toLocaleDateString()
    } catch {
      return ''
    }
  }

  /**
   * Shorten a DID to a more compact form.
   * @param didStr - The DID to shorten.
   * @returns The shortened DID.
   */
  function shortDid(didStr: string): string {
    if (!didStr) {
      return ''
    }
    if (didStr.length <= 24) {
      return didStr
    }
    return didStr.slice(0, 16) + '…' + didStr.slice(-6)
  }

  /**
   * Extract the parent author from a URI.
   * @param uriStr - The URI to extract the parent author from.
   * @returns The parent author.
   */
  function parentAuthor(uriStr: string): string {
    return (uriStr || '').replace('at://', '').split('/')[0]
  }

  /**
   * Get the author handle for a post.
   * @returns The author handle for the post.
   */
  function getPostAuthorHandle(): string {
    return post.authorHandle || shortDid(post.author)
  }

  getPostAuthorHandle()
</script>

<article class="post-card" class:private={post.isPrivate}>
    {#if post.reply}
        <div class="reply-context">
            ↩ replying to {shortDid(parentAuthor(post.reply.parent.uri))}
        </div>
    {/if}

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
            <span class="domain-badge">{displayBoundary(domain)}</span>
        {/each}
    </div>

    <p class="post-text">{post.text}</p>

    {#if post.embed}
        {@render renderEmbed(post.embed)}
    {/if}

    {#snippet renderEmbed(embed)}
        {#if embed.$type === 'app.bsky.embed.images' || embed.$type === 'zone.stratos.embed.images'}
            <div class="post-images">
                {#each (embed.images || []) as img}
                    <img src={getImageUrl(img)} alt={img.alt} class="post-image"/>
                {/each}
            </div>
        {:else if embed.image}
            <div class="post-images">
                <img src={getImageUrl(embed)} alt={embed.alt} class="post-image"/>
            </div>
        {:else if embed.$type === 'app.bsky.embed.external' && embed.external}
            <a href={embed.external.uri} target="_blank" rel="noopener noreferrer"
               class="external-embed">
                {#if embed.external.thumb}
                    {@const cid = getCid(embed.external.thumb)}
                    {#if cid && imageUrls[cid]}
                        <img src={imageUrls[cid]} alt={embed.external.title}
                             class="external-thumb"/>
                    {/if}
                {/if}
                <div class="external-content">
                    <div class="external-title">{embed.external.title}</div>
                    <div class="external-description">{embed.external.description}</div>
                </div>
            </a>
        {:else if embed.$type === 'app.bsky.embed.recordWithMedia' && embed.media}
            {@render renderEmbed(embed.media)}
        {/if}
    {/snippet}

    <div class="post-actions">
        <button class="reply-btn" onclick={() => onreply(post)}>Reply</button>
        {#if post.isPrivate}
            <button
                    class="inspect-btn"
                    class:active={inspectorOpen}
                    onclick={() => inspectorOpen = !inspectorOpen}
                    title="Inspect PDS stub vs Stratos record"
            >🔍
            </button>
        {/if}
    </div>

    {#if inspectorOpen}
        <RecordInspector uri={post.uri} onclose={() => inspectorOpen = false}/>
    {/if}
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

    .reply-context {
        font-size: 0.78rem;
        color: #888;
        margin-bottom: 0.3rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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

    .post-text {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.45;
    }

    .post-images {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 0.5rem;
        margin-top: 0.5rem;
    }

    .post-image {
        width: 100%;
        border-radius: 8px;
        object-fit: cover;
        max-height: 300px;
        border: 1px solid #eee;
    }

    .external-embed {
        display: flex;
        flex-direction: column;
        border: 1px solid #eee;
        border-radius: 8px;
        margin-top: 0.5rem;
        overflow: hidden;
        text-decoration: none;
        color: inherit;
    }

    .external-thumb {
        width: 100%;
        aspect-ratio: 1.91 / 1;
        object-fit: cover;
        border-bottom: 1px solid #eee;
    }

    .external-content {
        padding: 0.75rem;
    }

    .external-title {
        font-weight: 600;
        font-size: 0.9rem;
        margin-bottom: 0.25rem;
    }

    .external-description {
        font-size: 0.8rem;
        color: #666;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    .post-actions {
        margin-top: 0.4rem;
    }

    .reply-btn {
        background: none;
        border: none;
        color: #888;
        font-size: 0.8rem;
        cursor: pointer;
        padding: 0.15rem 0.4rem;
        border-radius: 4px;
    }

    .reply-btn:hover {
        background: #f3f4f6;
        color: #333;
    }

    .inspect-btn {
        background: none;
        border: none;
        font-size: 0.82rem;
        cursor: pointer;
        padding: 0.15rem 0.4rem;
        border-radius: 4px;
        opacity: 0.5;
        transition: opacity 0.15s;
    }

    .inspect-btn:hover,
    .inspect-btn.active {
        opacity: 1;
        background: #ede9fe;
    }
</style>

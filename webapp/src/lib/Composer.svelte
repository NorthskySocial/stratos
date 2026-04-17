<script lang="ts">
  import {Agent} from '@atproto/api'
  import type {OAuthSession} from '@atproto/oauth-client-browser'
  import type {StratosEnrollment} from './stratos'
  import type {FeedPost, ReplyRef} from './feed'
  import {displayBoundary} from './boundary-display'
  import {configureAgent} from './stratos-agent'

  interface Props {
    session: OAuthSession
    enrollment: StratosEnrollment | null
    stratosAgent: Agent | null
    replyingTo: FeedPost | null
    onpost: () => void
    oncancelreply: () => void
  }

  let {session, enrollment, stratosAgent, replyingTo, onpost, oncancelreply}: Props = $props()

  let text = $state('')
  const CHAR_LIMIT = 300
  let charsRemaining = $derived(CHAR_LIMIT - text.length)
  let isPrivate = $state(true)
  let selectedDomain = $state('')
  let posting = $state(false)
  let uploading = $state(false)
  let selectedFile: File | null = $state(null)
  let imagePreview: string | null = $state(null)
  let altText = $state('')

  let error = $state('')

  let domains = $derived(
    enrollment?.boundaries.map((b) => b.value).filter(Boolean) ?? [],
  )

  $effect(() => {
    if (domains.length > 0 && !selectedDomain) {
      selectedDomain = domains[0]
    }
  })

  $effect(() => {
    if (replyingTo?.isPrivate) {
      isPrivate = true
    }
  })

  function handleFileChange(e: Event) {
    const target = e.target as HTMLInputElement
    const file = target.files?.[0]
    if (file) {
      selectedFile = file
      const reader = new FileReader()
      reader.onload = (e) => {
        imagePreview = e.target?.result as string
      }
      reader.readAsDataURL(file)
    }
  }

  function clearImage() {
    selectedFile = null
    imagePreview = null
    altText = ''
  }

  function buildReplyRef(parent: FeedPost): ReplyRef {
    const parentRef = {uri: parent.uri, cid: parent.cid}
    const rootRef = parent.reply ? parent.reply.root : parentRef
    return {root: rootRef, parent: parentRef}
  }

  function shortDid(did: string): string {
    if (did.length <= 24) {
      return did
    }
    return did.slice(0, 16) + '…' + did.slice(-6)
  }

  async function handlePost() {
    if (!text.trim() && !selectedFile) {
      return
    }
    posting = true
    error = ''

    try {
      const now = new Date().toISOString()
      const replyRef = replyingTo ? buildReplyRef(replyingTo) : undefined
      let embed: FeedPost['embed'] | undefined

      if (selectedFile) {
        uploading = true
        try {
          if (isPrivate && stratosAgent) {
            console.log('Uploading private image to Stratos')
            // Use Stratos-specific blob upload for private posts
            const uploadRes = await stratosAgent.com.atproto.repo.uploadBlob(selectedFile, {encoding: selectedFile.type})
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const blob = uploadRes.data.blob as any
            blob.$type = 'blob' // Ensure it has $type: 'blob'
            blob.mimeType = selectedFile.type // Ensure mimeType is set correctly
            blob.size = selectedFile.size // Ensure size is set correctly
            embed = {
              $type: 'zone.stratos.embed.images',
              images: [
                {
                  alt: altText,
                  image: blob,
                },
              ],
            }
          } else {
            console.log('Uploading public image to Atproto')
            const agent = configureAgent(new Agent(session))
            const uploadRes = await agent.uploadBlob(
              selectedFile,
              {
                encoding: selectedFile.type,
              }
            )
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const blob = uploadRes.data.blob as any
            blob.$type = 'blob' // Ensure it has $type: 'blob' for public too
            embed = {
              $type: 'app.bsky.embed.images',
              images: [
                {
                  alt: altText,
                  image: blob,
                },
              ],
            }
          }
        } finally {
          uploading = false
        }
      }

      if (isPrivate && stratosAgent && selectedDomain) {
        await stratosAgent.com.atproto.repo.createRecord({
          repo: session.sub,
          collection: 'zone.stratos.feed.post',
          record: {
            $type: 'zone.stratos.feed.post',
            text: text.trim(),
            boundary: {
              $type: 'zone.stratos.boundary.defs#Domains',
              values: [{value: selectedDomain}],
            },
            ...(replyRef ? {reply: replyRef} : {}),
            ...(embed ? {embed} : {}),
            createdAt: now,
          },
        })
      } else {
        console.log('Creating public post with Atproto')
        const agent = configureAgent(new Agent(session))
        await agent.call('com.atproto.repo.createRecord', {
          repo: session.sub,
          collection: 'app.bsky.feed.post',
          record: {
            $type: 'app.bsky.feed.post',
            text: text.trim(),
            ...(replyRef ? {reply: replyRef} : {}),
            ...(embed ? {embed} : {}),
            createdAt: now,
          },
        })
      }

      text = ''
      clearImage()
      oncancelreply()
      onpost()
    } catch (err) {
      console.error('Post failed:', err)
      const message = err instanceof Error ? err.message : 'Failed to create post'
      if (!isPrivate && message.includes('Missing required scope')) {
        error = 'Public posting is not available — this demo is for private data only.'
      } else {
        error = message
      }
    } finally {
      posting = false
    }
  }
</script>

<div class="composer">
    {#if replyingTo}
        <div class="reply-indicator">
            <span>Replying to @{replyingTo.authorHandle || shortDid(replyingTo.author)}</span>
            <button class="cancel-reply" onclick={oncancelreply}>✕</button>
        </div>
    {/if}

    <textarea
            bind:value={text}
            placeholder={isPrivate ? `Post to ${selectedDomain ? displayBoundary(selectedDomain) : 'private'}…` : 'Write a post…'}
            disabled={posting}
            rows="3"
    ></textarea>

    {#if imagePreview}
        <div class="image-preview-container">
            <img src={imagePreview} alt="Preview" class="image-preview"/>
            <button class="remove-image" onclick={clearImage} disabled={posting}>✕</button>
            <div class="alt-text-container">
                <input
                        type="text"
                        bind:value={altText}
                        placeholder="Add alt text…"
                        disabled={posting}
                        class="alt-text-input"
                />
            </div>
        </div>
    {/if}

    <div class="composer-actions">
        <div class="left-actions">
            <label class="image-upload" class:disabled={posting}>
                <input
                        type="file"
                        accept="image/*"
                        onchange={handleFileChange}
                        disabled={posting}
                        style="display: none;"
                />
                <span class="icon">🖼️</span>
            </label>

            <label class="private-toggle" class:disabled={!enrollment}>
                <input
                        type="checkbox"
                        bind:checked={isPrivate}
                        disabled={!enrollment || posting}
                />
                <span>Private</span>
                {#if !enrollment}
                    <span class="tooltip">Enroll in Stratos to post privately</span>
                {/if}
            </label>

            {#if isPrivate && domains.length > 0}
                <select
                        class="domain-select"
                        bind:value={selectedDomain}
                        disabled={posting}
                >
                    {#each domains as domain}
                        <option value={domain}>{displayBoundary(domain)}</option>
                    {/each}
                </select>
            {/if}
        </div>

        <button onclick={handlePost}
                disabled={posting || (!text.trim() && !selectedFile) || charsRemaining < 0}>
      <span class="char-count" class:near-limit={charsRemaining < 20}
            class:over-limit={charsRemaining < 0}>
        {charsRemaining}
      </span>
            {posting ? (uploading ? 'Uploading…' : 'Posting…') : 'Post'}
        </button>
    </div>

    {#if error}
        <p class="error">{error}</p>
    {/if}
</div>

<style>
    .composer {
        padding: 1rem;
        border-bottom: 1px solid #eee;
    }

    .reply-indicator {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #f0f4ff;
        border: 1px solid #d0d9f0;
        border-radius: 6px;
        padding: 0.35rem 0.6rem;
        margin-bottom: 0.5rem;
        font-size: 0.82rem;
        color: #3730a3;
    }

    .cancel-reply {
        background: none;
        border: none;
        color: #888;
        cursor: pointer;
        font-size: 0.9rem;
        padding: 0 0.3rem;
        line-height: 1;
    }

    .cancel-reply:hover {
        color: #333;
    }

    textarea {
        width: 100%;
        padding: 0.6rem 0.75rem;
        border: 1px solid #ccc;
        border-radius: 6px;
        font-size: 0.95rem;
        font-family: inherit;
        resize: vertical;
        box-sizing: border-box;
    }

    textarea:focus {
        outline: none;
        border-color: #0066ff;
        box-shadow: 0 0 0 2px rgba(0, 102, 255, 0.15);
    }

    .image-preview-container {
        position: relative;
        margin-top: 0.5rem;
        display: inline-block;
    }

    .image-preview {
        max-width: 100%;
        max-height: 200px;
        border-radius: 8px;
        display: block;
        border: 1px solid #eee;
    }

    .remove-image {
        position: absolute;
        top: 0.25rem;
        right: 0.25rem;
        background: rgba(0, 0, 0, 0.5);
        color: white;
        border: none;
        border-radius: 50%;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 0.75rem;
        padding: 0;
    }

    .remove-image:hover {
        background: rgba(0, 0, 0, 0.7);
    }

    .alt-text-container {
        margin-top: 0.5rem;
        width: 100%;
    }

    .alt-text-input {
        width: 100%;
        padding: 0.4rem 0.6rem;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 0.85rem;
        box-sizing: border-box;
    }

    .alt-text-input:focus {
        outline: none;
        border-color: #0066ff;
    }

    .composer-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 0.5rem;
    }

    .left-actions {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .image-upload {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        transition: background 0.15s;
        font-size: 1.2rem;
    }

    .image-upload:hover:not(.disabled) {
        background: #f3f4f6;
    }

    .image-upload.disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .private-toggle {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.85rem;
        cursor: pointer;
        position: relative;
    }

    .private-toggle.disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .private-toggle input:checked + span {
        color: #8b5cf6;
        font-weight: 600;
    }

    .tooltip {
        display: none;
        position: absolute;
        bottom: 100%;
        left: 0;
        background: #333;
        color: white;
        padding: 0.3rem 0.5rem;
        border-radius: 4px;
        font-size: 0.75rem;
        white-space: nowrap;
        margin-bottom: 0.3rem;
    }

    .private-toggle.disabled:hover .tooltip {
        display: block;
    }

    .domain-select {
        padding: 0.3rem 0.5rem;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 0.82rem;
        background: white;
        color: #333;
    }

    .domain-select:focus {
        outline: none;
        border-color: #8b5cf6;
    }

    button {
        padding: 0.45rem 1rem;
        background: #0066ff;
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 0.85rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .char-count {
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.8);
        font-variant-numeric: tabular-nums;
    }

    .char-count.near-limit {
        color: #ffd700;
    }

    .char-count.over-limit {
        color: #ff4d4d;
        font-weight: bold;
    }

    button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    button:not(:disabled):hover {
        background: #0052cc;
    }

    .error {
        margin-top: 0.5rem;
        color: #cc0000;
        font-size: 0.85rem;
    }
</style>

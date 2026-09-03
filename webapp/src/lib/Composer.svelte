<script lang="ts">
  import { tick } from 'svelte'
  import {Agent} from '@atproto/api'
  import type {OAuthSession} from '@atproto/oauth-client-browser'
  import type {StratosEnrollment} from './stratos'
  import type {FeedPost, ReplyRef} from './feed'
  import {displayBoundary} from './boundary-display'
  import {configureAgent} from './stratos-agent'
  import {boundaryToSpaceUri} from '@northskysocial/stratos-core'
  import {getSpaceWriteScopeStatus, type SpaceWriteScopeStatus} from './auth'

  interface Props {
    session: OAuthSession
    enrollment: StratosEnrollment | null
    attestationVerified: boolean | null
    stratosAgent: Agent | null
    replyingTo: FeedPost | null
    onpost: () => void
    oncancelreply: () => void
  }

  let {session, enrollment, attestationVerified, stratosAgent, replyingTo, onpost, oncancelreply}: Props = $props()

  let text = $state('')
  const CHAR_LIMIT = 300
  let charsRemaining = $derived(CHAR_LIMIT - text.length)
  let isTextInvalid = $derived(charsRemaining < 0)
  let characterCount = $derived(
    charsRemaining < 0
      ? `${Math.abs(charsRemaining)} character${charsRemaining === -1 ? '' : 's'} over the ${CHAR_LIMIT}-character limit.`
      : `${charsRemaining} characters remaining of ${CHAR_LIMIT}.`,
  )
  let isPrivate = $state(true)
  let selectedDomain = $state('')
  let posting = $state(false)
  let uploading = $state(false)
  let selectedFile: File | null = $state(null)
  let imagePreview: string | null = $state(null)
  let altText = $state('')
  let spaceWriteScope = $state<SpaceWriteScopeStatus | 'checking'>('checking')

  let error = $state('')
  let status = $state('')
  let textArea = $state<HTMLTextAreaElement>()

  let privatePostingDisabled = $derived(!enrollment || attestationVerified !== true)
  let privateModeUnavailable = $derived(privatePostingDisabled)
  let pdsPrivatePost = $derived(
    isPrivate && enrollment?.custody === 'pds',
  )

  let domains = $derived(
    enrollment?.boundaries.map((b) => b.value).filter(Boolean) ?? [],
  )

  $effect(() => {
    if (domains.length > 0 && !selectedDomain) {
      selectedDomain = domains[0]
    }
  })

  $effect(() => {
    if (enrollment !== null) {
      spaceWriteScope = 'checking'
      return
    }
    let cancelled = false
    spaceWriteScope = 'checking'
    getSpaceWriteScopeStatus(session).then((status) => {
      if (!cancelled) {
        spaceWriteScope = status
      }
    })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    if (privateModeUnavailable) {
      isPrivate = false
    }
  })

  $effect(() => {
    if (replyingTo?.isPrivate && !privateModeUnavailable) {
      isPrivate = true
    }
  })

  $effect(() => {
    if (replyingTo) {
      void tick().then(() => textArea?.focus())
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

  function spaceUriFromBoundary(boundary: string): string {
    const result = boundaryToSpaceUri(boundary, 'zone.stratos.space.feed')
    if (!result.ok) {
      throw new Error(`The selected private space is invalid: ${result.error.message}`)
    }
    return result.value
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
    if (isPrivate && privatePostingDisabled) {
      error = 'Private posting is disabled because the enrollment attestation is not valid.'
      return
    }
    if (isPrivate && !selectedDomain) {
      error = 'Select an enrolled private space before posting.'
      return
    }
    if (isPrivate && enrollment?.custody === 'stratos' && !stratosAgent) {
      error = 'Private posting is unavailable because the Stratos service is not connected.'
      return
    }
    posting = true
    error = ''
    status = 'Creating post.'

    try {
      const now = new Date().toISOString()
      const replyRef = replyingTo ? buildReplyRef(replyingTo) : undefined
      let embed: FeedPost['embed'] | undefined

      if (selectedFile) {
        if (pdsPrivatePost) {
          throw new Error('Images are not available for PDS-hosted private posts yet.')
        }
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

      if (isPrivate && enrollment?.custody === 'pds') {
        const response = await session.fetchHandler(
          '/xrpc/com.atproto.space.createRecord',
          {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
              space: spaceUriFromBoundary(selectedDomain),
              repo: session.sub,
              collection: 'zone.stratos.feed.post',
              validate: false,
              record: {
                $type: 'zone.stratos.feed.post',
                text: text.trim(),
                ...(replyRef ? {reply: replyRef} : {}),
                createdAt: now,
              },
            }),
          },
        )
        if (!response.ok) {
          const responseText = await response.text().catch(() => '')
          throw new Error(responseText || `PDS write failed (${response.status})`)
        }
      } else if (isPrivate && enrollment?.custody === 'stratos' && stratosAgent) {
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
      } else if (!isPrivate) {
        console.log('Creating public post with Atproto')
        const agent = configureAgent(new Agent(session))
        await agent.com.atproto.repo.createRecord({
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
      status = 'Post created.'
    } catch (err) {
      console.error('Post failed:', err)
      status = ''
      const message = err instanceof Error ? err.message : 'Failed to create post'
      if (pdsPrivatePost && message.toLowerCase().includes('scope')) {
        error = 'Private posting requires a new space permission. Sign out and authorize the app again.'
      } else if (!isPrivate && message.includes('Missing required scope')) {
        error = 'Public posting is not available — this demo is for private data only.'
      } else {
        error = 'Could not create the post. Try again.'
      }
    } finally {
      posting = false
    }
  }
</script>

<div class="composer" aria-busy={posting}>
    {#if replyingTo}
        <div class="reply-indicator">
            <span>Replying to @{replyingTo.authorHandle || shortDid(replyingTo.author)}</span>
            <button class="cancel-reply" onclick={oncancelreply} aria-label="Cancel reply">✕</button>
        </div>
    {/if}

    <label class="sr-only" for="post-text">Post text</label>
    <textarea
            id="post-text"
            bind:this={textArea}
            bind:value={text}
            placeholder={isPrivate ? `Post to ${selectedDomain ? displayBoundary(selectedDomain) : 'private'}…` : 'Write a post…'}
            disabled={posting}
            rows="3"
            aria-invalid={isTextInvalid}
            aria-describedby="post-guidance post-character-count"
    ></textarea>
    <p id="post-guidance" class="sr-only">Maximum {CHAR_LIMIT} characters.</p>
    <p id="post-character-count" class="sr-only" role="status">{characterCount}</p>

    {#if imagePreview}
        <div class="image-preview-container">
            <img src={imagePreview} alt="Preview" class="image-preview"/>
            <button class="remove-image" onclick={clearImage} disabled={posting} aria-label="Remove image">✕</button>
            <div class="alt-text-container">
                <label class="sr-only" for="image-alt-text">Image description</label>
                <input
                        id="image-alt-text"
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
            <label class="image-upload" class:disabled={posting || pdsPrivatePost}>
                <input
                        id="image-upload"
                        type="file"
                        accept="image/*"
                        onchange={handleFileChange}
                        disabled={posting || pdsPrivatePost}
                        class="file-input"
                />
                <span class="icon" aria-hidden="true">🖼️</span>
                <span class="sr-only">Add image</span>
            </label>
            {#if pdsPrivatePost}
                <span class="posting-note">Images are not available for PDS-hosted private posts yet.</span>
            {/if}

            <label class="private-toggle" class:disabled={privateModeUnavailable}>
                <input
                        type="checkbox"
                        bind:checked={isPrivate}
                        disabled={privateModeUnavailable || posting}
                        aria-describedby={privateModeUnavailable ? 'private-posting-help' : undefined}
                />
                <span>Private</span>
            </label>
            {#if !enrollment}
                <p id="private-posting-help" class="posting-note">Enroll in Stratos to post privately.</p>
            {:else if privatePostingDisabled}
                <p id="private-posting-help" class="posting-note">Private posting requires a valid enrollment attestation.</p>
            {/if}

            {#if isPrivate && domains.length > 0}
                <label class="sr-only" for="private-space">Private space</label>
                <select
                        id="private-space"
                        class="domain-select"
                        bind:value={selectedDomain}
                        disabled={posting}
                >
                    {#each domains as domain (domain)}
                        <option value={domain}>{displayBoundary(domain)}</option>
                    {/each}
                </select>
            {/if}
        </div>

        <button onclick={handlePost}
                disabled={posting || (!text.trim() && !selectedFile) || charsRemaining < 0}>
      <span class="char-count" aria-hidden="true" class:near-limit={charsRemaining < 20}
            class:over-limit={charsRemaining < 0}>
        {charsRemaining}
      </span>
            {posting ? (uploading ? 'Uploading…' : 'Posting…') : 'Post'}
        </button>
    </div>

    {#if error}
        <p class="error" role="alert">{error}</p>
    {/if}
    <p class="sr-only" role="status">{status}</p>
    {#if !enrollment && spaceWriteScope !== 'checking'}
        <p class="posting-note">
            {spaceWriteScope === 'granted'
              ? 'Your PDS will hold your private posts after enrollment.'
              : spaceWriteScope === 'missing'
                ? 'Stratos will hold your private posts after enrollment.'
                : 'Private posting permission could not be verified.'}
        </p>
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

    textarea:focus-visible,
    input:focus-visible,
    select:focus-visible,
    button:focus-visible,
    .image-upload:focus-within {
        outline: 3px solid #1d4ed8;
        outline-offset: 2px;
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

    .file-input,
    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
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

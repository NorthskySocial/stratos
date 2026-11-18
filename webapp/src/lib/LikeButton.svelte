<script lang="ts">
  import type {OAuthSession} from '@atproto/oauth-client-browser'
  import {
    createBoundaryRecord,
    deleteBoundaryRecord,
    ScopeUpgradeRequiredError,
  } from '@northskysocial/stratos-client'
  import type {FeedPost} from './feed'
  import type {StratosEnrollment} from './stratos'
  import {stratosWriteClient} from './boundary-writes'

  interface Props {
    post: FeedPost
    session: Pick<OAuthSession, 'sub' | 'fetchHandler'>
    enrollment: StratosEnrollment
    attestationVerified: boolean | null
  }

  const LIKE_COLLECTION = 'app.bsky.feed.like'

  let {post, session, enrollment, attestationVerified}: Props = $props()

  const noteId = $props.id()

  // What this member did since the feed last said what they had. The feed generator ingests a write a moment later, so a refresh that does not show it yet must not undo it.
  let own = $state<{likeUri: string | undefined; likeCount: number} | null>(null)
  let busy = $state(false)
  let error = $state('')

  let feedAgrees = $derived(own === null || Boolean(post.viewer?.like) === Boolean(own.likeUri))
  let likeUri = $derived(own && !feedAgrees ? own.likeUri : post.viewer?.like)
  let likeCount = $derived(own && !feedAgrees ? own.likeCount : (post.likeCount ?? 0))
  let pdsCustody = $derived(enrollment.custody === 'pds')
  let attestationMissing = $derived(attestationVerified !== true)
  let unavailableReason = $derived(
    pdsCustody
      ? 'Likes are not available for PDS-hosted private posts yet.'
      : attestationMissing
        ? 'Liking requires a valid enrollment attestation.'
        : '',
  )

  $effect(() => {
    if (feedAgrees) own = null
  })

  function describeFailure(err: unknown): string {
    if (err instanceof ScopeUpgradeRequiredError) {
      return 'Sign out and authorize the app again to like posts.'
    }
    return 'Could not like the post. Try again.'
  }

  async function like() {
    const boundary = post.boundaries[0]
    if (!boundary) throw new Error('The post names no boundary')
    const created = await createBoundaryRecord(
      stratosWriteClient(session, enrollment),
      {
        boundary,
        repo: session.sub,
        collection: LIKE_COLLECTION,
        record: {
          $type: LIKE_COLLECTION,
          subject: {uri: post.uri, cid: post.cid},
          createdAt: new Date().toISOString(),
        },
      },
    )
    if (!created.ok) throw new Error(created.reason)
    own = {likeUri: created.value.uri, likeCount: likeCount + 1}
  }

  async function unlike(existingLikeUri: string) {
    const boundary = post.boundaries[0]
    if (!boundary) throw new Error('The post names no boundary')
    const rkey = existingLikeUri.split('/').pop() ?? ''
    const deleted = await deleteBoundaryRecord(
      stratosWriteClient(session, enrollment),
      {boundary, repo: session.sub, collection: LIKE_COLLECTION, rkey},
    )
    if (!deleted.ok) throw new Error(deleted.reason)
    own = {likeUri: undefined, likeCount: Math.max(0, likeCount - 1)}
  }

  async function toggle() {
    if (busy || unavailableReason) return
    busy = true
    error = ''
    try {
      if (likeUri) {
        await unlike(likeUri)
      } else {
        await like()
      }
    } catch (err) {
      console.error('Like failed:', err)
      error = describeFailure(err)
    } finally {
      busy = false
    }
  }
</script>

<span class="like">
    <button
            class="like-btn"
            class:liked={!!likeUri}
            onclick={() => void toggle()}
            disabled={busy || unavailableReason !== ''}
            aria-pressed={!!likeUri}
            aria-describedby={unavailableReason ? noteId : undefined}
    >{likeUri ? 'Unlike' : 'Like'}</button>
    <span class="like-count" role="status">{likeCount} {likeCount === 1 ? 'like' : 'likes'}</span>
    {#if unavailableReason}
        <span id={noteId} class="like-note">{unavailableReason}</span>
    {/if}
    {#if error}
        <span class="like-error" role="alert">{error}</span>
    {/if}
</span>

<style>
    .like {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
    }

    .like-btn {
        background: none;
        border: none;
        color: #888;
        font-size: 0.8rem;
        cursor: pointer;
        padding: 0.15rem 0.4rem;
        border-radius: 4px;
    }

    .like-btn:hover:not(:disabled) {
        background: #f3f4f6;
        color: #333;
    }

    .like-btn.liked {
        color: #be185d;
    }

    .like-btn:disabled {
        cursor: not-allowed;
        opacity: 0.65;
    }

    .like-btn:focus-visible {
        outline: 3px solid #1d4ed8;
        outline-offset: 2px;
    }

    .like-count,
    .like-note {
        font-size: 0.78rem;
        color: #666;
    }

    .like-error {
        font-size: 0.78rem;
        color: #b91c1c;
    }
</style>

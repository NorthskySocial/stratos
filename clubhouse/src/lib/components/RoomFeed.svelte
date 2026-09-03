<script lang="ts">
  import type { ClubhouseFeedPost } from '../feedgen'
  import type { RoomFeedState } from '../types'

  interface Props {
    feedState: RoomFeedState
    posts: readonly ClubhouseFeedPost[]
    hasMore: boolean
    message: string
    onLoadMore: () => void
    onPost: (text: string) => Promise<void>
  }

  let { feedState, posts, hasMore, message, onLoadMore, onPost }: Props = $props()
  let text = $state('')
  let draftRevision = $state(0)
  let posting = $state(false)

  function updateText() {
    draftRevision += 1
  }

  async function submitPost() {
    const submittedText = text
    const submittedDraftRevision = draftRevision
    posting = true
    try {
      await onPost(submittedText)
      if (draftRevision === submittedDraftRevision) {
        text = ''
      }
    } catch {
      // The parent renders a recoverable error; keep the draft for retry.
    } finally {
      posting = false
    }
  }
</script>

<div class="feed-panel">
  <form class="post-composer" onsubmit={(event) => { event.preventDefault(); void submitPost() }}>
    <label for="room-post">Write a flat room post</label>
    <textarea id="room-post" bind:value={text} oninput={updateText} maxlength="300" rows="3" placeholder="Share something with this room." aria-describedby={message ? 'room-post-message' : undefined}></textarea>
    <div class="composer-actions">
      <p>Text only. Clubhouse does not create replies or threads.</p>
      <button class="button button-primary" type="submit" disabled={posting || !text.trim()}>
        {posting ? 'Posting…' : 'Post'}
      </button>
    </div>
    {#if message}
      <p id="room-post-message" class="composer-message" role="alert">{message}</p>
    {/if}
  </form>

  {#if feedState === 'loading'}
    <p class="feed-status" aria-busy="true">Loading room posts…</p>
  {:else if feedState !== 'ready' && feedState !== 'empty'}
    <div class="feed-status feed-status-error">
      <h2>{feedState === 'BoundaryMismatch' ? 'Join required' : feedState === 'FeedNotReady' ? 'Room is synchronizing' : 'Room unavailable'}</h2>
      <p>{message}</p>
    </div>
  {:else if feedState === 'empty'}
    <p class="feed-status">No posts are visible here yet.</p>
  {:else}
    <ol class="post-list" aria-label="Room posts">
      {#each posts as post (post.uri)}
        <li class="post">
          <p class="post-author">{post.author.handle ?? post.author.did}</p>
          <p class="post-text">{post.text}</p>
          <time datetime={post.indexedAt}>{new Date(post.indexedAt).toLocaleString()}</time>
        </li>
      {/each}
    </ol>
    {#if hasMore}
      <button class="button button-secondary" type="button" onclick={onLoadMore}>Load more posts</button>
    {/if}
  {/if}
</div>

<script lang="ts">
  import type { ClubhouseFeedPost } from '../feedgen'
  import type { ReplyRef } from '../post-writer'
  import type { RoomFeedState } from '../types'

  interface Props {
    feedState: RoomFeedState
    posts: readonly ClubhouseFeedPost[]
    hasMore: boolean
    message: string
    topicUri: string | null
    onOpenTopic: (uri: string) => void
    onCloseTopic: () => void
    onLoadMore: () => void
    onPost: (text: string, reply?: ReplyRef) => Promise<void>
  }

  let { feedState, posts, hasMore, message, topicUri, onOpenTopic, onCloseTopic, onLoadMore, onPost }: Props = $props()
  let text = $state('')
  let draftRevision = $state(0)
  let posting = $state(false)
  let replyingToUri = $state<string | null>(null)

  const topics = $derived(posts.filter((post) => !post.reply))
  const openTopic = $derived(posts.find((post) => post.uri === topicUri))
  const threadPosts = $derived(topicUri
    ? posts.filter((post) => post.uri === topicUri || post.reply?.root.uri === topicUri)
    : [])
  const replyingTo = $derived(posts.find((post) => post.uri === replyingToUri))

  function replyRef(post: ClubhouseFeedPost): ReplyRef {
    return {
      root: post.reply?.root ?? { uri: post.uri, cid: post.cid },
      parent: { uri: post.uri, cid: post.cid },
    }
  }

  async function submitPost() {
    const submittedText = text
    const revision = draftRevision
    posting = true
    try {
      await onPost(submittedText, replyingTo ? replyRef(replyingTo) : undefined)
      if (draftRevision === revision) text = ''
      replyingToUri = null
    } catch {
      // Keep the draft for retry.
    } finally {
      posting = false
    }
  }

</script>

<div class="feed-panel">
  {#if !topicUri}
    <form class="post-composer" onsubmit={(event) => { event.preventDefault(); void submitPost() }}>
      <label for="room-post">Start a topic</label>
      <textarea id="room-post" bind:value={text} oninput={() => draftRevision += 1} maxlength="300" rows="3" placeholder="What should the room discuss?" aria-describedby={message ? 'room-post-message' : undefined}></textarea>
      <div class="composer-actions"><p>A new top-level topic.</p><button class="button button-primary" type="submit" disabled={posting || !text.trim()}>{posting ? 'Posting…' : 'Post topic'}</button></div>
      {#if message}<p id="room-post-message" class="composer-message" role="alert">{message}</p>{/if}
    </form>
  {/if}

  {#if feedState === 'loading'}
    <p class="feed-status" aria-busy="true">Loading room topics…</p>
  {:else if feedState !== 'ready' && feedState !== 'empty'}
    <div class="feed-status feed-status-error">
      <h2>{feedState === 'BoundaryMismatch' ? 'Join required' : feedState === 'FeedNotReady' ? 'Room is synchronizing' : 'Room unavailable'}</h2>
      <p>{message}</p>
    </div>
  {:else if feedState === 'empty'}
    <p class="feed-status">No topics are visible here yet.</p>
  {:else if topicUri && !openTopic}
    <div class="feed-status feed-status-error"><h2>Topic unavailable</h2><p>This topic is not in the loaded room history.</p>{#if hasMore}<button class="button button-secondary" type="button" onclick={onLoadMore}>Load more history</button>{/if}</div>
  {:else if openTopic}
    <section class="thread-view" aria-label="Topic thread">
      <button class="thread-back" type="button" onclick={() => { replyingToUri = null; onCloseTopic() }}>← All topics</button>
      <article class="post topic-root">
        <p class="post-author">{openTopic.author.handle ?? openTopic.author.did}</p>
        <p class="post-text">{openTopic.text}</p>
        <div class="post-meta"><time datetime={openTopic.indexedAt}>{new Date(openTopic.indexedAt).toLocaleString()}</time><button class="button button-primary" type="button" onclick={() => replyingToUri = openTopic.uri}>Reply to topic</button></div>
      </article>
      <h2 class="responses-title">Responses</h2>
      <ol class="post-list thread-list">
        {#each threadPosts.filter((post) => post.uri !== openTopic.uri) as post (post.uri)}
          <li class="post thread-reply">
            <p class="post-author">{post.author.handle ?? post.author.did}</p>
            <p class="post-text">{post.text}</p>
            <div class="post-meta"><time datetime={post.indexedAt}>{new Date(post.indexedAt).toLocaleString()}</time><button type="button" onclick={() => replyingToUri = post.uri}>Reply</button></div>
          </li>
        {/each}
      </ol>
      {#if hasMore}
        <button class="button button-secondary" type="button" onclick={onLoadMore}>Load more replies</button>
      {/if}
    </section>
  {:else}
    <ol class="post-list" aria-label="Room topics">
      {#each topics as post (post.uri)}
        <li class="post topic-card">
          <p class="post-author">{post.author.handle ?? post.author.did}</p>
          <p class="post-text">{post.text}</p>
          <div class="post-meta"><time datetime={post.indexedAt}>{new Date(post.indexedAt).toLocaleString()}</time><div><button type="button" onclick={() => onOpenTopic(post.uri)}>Open topic</button><button type="button" onclick={() => { onOpenTopic(post.uri); replyingToUri = post.uri }}>Reply</button></div></div>
        </li>
      {/each}
    </ol>
    {#if hasMore}<button class="button button-secondary" type="button" onclick={onLoadMore}>Load more topics</button>{/if}
  {/if}
</div>

{#if replyingTo}
  <dialog class="reply-dialog" open aria-labelledby="reply-dialog-title">
    <form method="dialog" class="reply-dialog-card" onsubmit={(event) => { event.preventDefault(); void submitPost() }}>
      <div class="reply-dialog-heading"><h2 id="reply-dialog-title">Reply to {replyingTo.author.handle ?? replyingTo.author.did}</h2><button type="button" aria-label="Close reply dialog" onclick={() => replyingToUri = null}>×</button></div>
      <p class="reply-context">{replyingTo.text}</p>
      <label for="topic-reply">Your response</label>
      <textarea id="topic-reply" bind:value={text} oninput={() => draftRevision += 1} maxlength="300" rows="5" placeholder="Contribute to this topic."></textarea>
      <div class="composer-actions"><button class="button button-secondary" type="button" onclick={() => replyingToUri = null}>Cancel</button><button class="button button-primary" type="submit" disabled={posting || !text.trim()}>{posting ? 'Posting…' : 'Post reply'}</button></div>
    </form>
  </dialog>
{/if}

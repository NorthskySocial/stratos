<script lang="ts">
  import type { ClubhouseFeedPost } from '../feedgen'
  import type { ReplyRef } from '../post-writer'
  import type { RoomFeedState } from '../types'
  import IconaMoon from './IconaMoon.svelte'
  import DeletePostButton from './DeletePostButton.svelte'
  import PostAuthor from './PostAuthor.svelte'

  interface Props {
    feedState: RoomFeedState
    posts: readonly ClubhouseFeedPost[]
    hasMore: boolean
    feedMessage: string
    topicUri: string | null
    viewerDid: string | null
    onOpenTopic: (uri: string) => void
    onCloseTopic: () => void
    onLoadMore: () => void
    onPost: (text: string, reply?: ReplyRef) => Promise<void>
    onDelete: (post: ClubhouseFeedPost) => Promise<void>
  }

  let { feedState, posts, hasMore, feedMessage, topicUri, viewerDid, onOpenTopic, onCloseTopic, onLoadMore, onPost, onDelete }: Props = $props()
  let text = $state('')
  let draftRevision = $state(0)
  let posting = $state(false)
  let replyingToUri = $state<string | null>(null)
  let composerError = $state('')
  let replyError = $state('')

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

  function openReply(uri: string) {
    replyingToUri = uri
    replyError = ''
  }

  function closeReply() {
    replyingToUri = null
    replyError = ''
  }

  function failureText(cause: unknown): string {
    return cause instanceof Error ? cause.message : 'Post could not be created'
  }

  async function send(reply?: ReplyRef) {
    const submittedText = text
    const revision = draftRevision
    posting = true
    try {
      await onPost(submittedText, reply)
      if (draftRevision === revision) text = ''
    } finally {
      posting = false
    }
  }

  async function submitTopic() {
    composerError = ''
    try {
      await send()
    } catch (cause) {
      composerError = failureText(cause)
    }
  }

  async function submitReply() {
    if (!replyingTo) return
    replyError = ''
    try {
      await send(replyRef(replyingTo))
      closeReply()
    } catch (cause) {
      replyError = failureText(cause)
    }
  }

</script>

<div class="feed-panel">
  {#if !topicUri}
    <form class="post-composer" onsubmit={(event) => { event.preventDefault(); void submitTopic() }}>
      <div class="composer-heading"><span aria-hidden="true"><IconaMoon name="comment" /></span><label for="room-post">Start a topic</label></div>
      <textarea id="room-post" bind:value={text} oninput={() => draftRevision += 1} maxlength="300" rows="3" placeholder="What should the room discuss?" aria-describedby={composerError ? 'room-post-message' : undefined}></textarea>
      <div class="composer-actions"><p>A new top-level topic.</p><button class="button button-primary" type="submit" disabled={posting || !text.trim()}>{posting ? 'Posting…' : 'Post topic'}</button></div>
      {#if composerError}<p id="room-post-message" class="composer-message" role="alert">{composerError}</p>{/if}
    </form>
  {/if}

  {#if feedState === 'loading'}
    <p class="feed-status" aria-busy="true">Loading room topics…</p>
  {:else if feedState !== 'ready' && feedState !== 'empty'}
    <div class="feed-status feed-status-error">
      <h2>{feedState === 'BoundaryMismatch' ? 'Join required' : feedState === 'FeedNotReady' ? 'Room is synchronizing' : 'Room unavailable'}</h2>
      <p>{feedMessage}</p>
    </div>
  {:else if feedState === 'empty'}
    <p class="feed-status">No topics are visible here yet.</p>
  {:else if topicUri && !openTopic}
    <div class="feed-status feed-status-error"><h2>Topic unavailable</h2><p>This topic is not in the loaded room history.</p>{#if hasMore}<button class="button button-secondary" type="button" onclick={onLoadMore}>Load more history</button>{/if}</div>
  {:else if openTopic}
    <section class="thread-view" aria-label="Topic thread">
      <button class="thread-back" type="button" onclick={() => { closeReply(); onCloseTopic() }}><IconaMoon name="arrow-left" /> All topics</button>
      <article class="post topic-root">
        <PostAuthor author={openTopic.author} />
        <p class="post-text">{openTopic.text}</p>
        <div class="post-meta"><time datetime={openTopic.indexedAt}>{new Date(openTopic.indexedAt).toLocaleString()}</time><div><button class="button button-primary" type="button" onclick={() => openReply(openTopic.uri)}>Reply to topic</button>{#if viewerDid === openTopic.author.did}<DeletePostButton post={openTopic} noun="topic" {onDelete} />{/if}</div></div>
      </article>
      <h2 class="responses-title">Responses</h2>
      <ol class="post-list thread-list">
        {#each threadPosts.filter((post) => post.uri !== openTopic.uri) as post (post.uri)}
          <li class="post thread-reply">
            <PostAuthor author={post.author} />
            <p class="post-text">{post.text}</p>
            <div class="post-meta"><time datetime={post.indexedAt}>{new Date(post.indexedAt).toLocaleString()}</time><div><button type="button" onclick={() => openReply(post.uri)}>Reply</button>{#if viewerDid === post.author.did}<DeletePostButton {post} noun="reply" {onDelete} />{/if}</div></div>
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
          <PostAuthor author={post.author} />
          <p class="post-text">{post.text}</p>
          <div class="post-meta"><time datetime={post.indexedAt}>{new Date(post.indexedAt).toLocaleString()}</time><div><button type="button" onclick={() => onOpenTopic(post.uri)}>Open topic</button><button type="button" onclick={() => { onOpenTopic(post.uri); openReply(post.uri) }}>Reply</button>{#if viewerDid === post.author.did}<DeletePostButton {post} noun="topic" {onDelete} />{/if}</div></div>
        </li>
      {/each}
    </ol>
    {#if hasMore}<button class="button button-secondary" type="button" onclick={onLoadMore}>Load more topics</button>{/if}
  {/if}
</div>

{#if replyingTo}
  <dialog class="reply-dialog" open aria-labelledby="reply-dialog-title">
    <form method="dialog" class="reply-dialog-card" onsubmit={(event) => { event.preventDefault(); void submitReply() }}>
      <div class="reply-dialog-heading"><h2 id="reply-dialog-title">Reply to {replyingTo.author.handle ?? replyingTo.author.did}</h2><button type="button" aria-label="Close reply dialog" onclick={closeReply}><IconaMoon name="close" /></button></div>
      <p class="reply-context">{replyingTo.text}</p>
      <label for="topic-reply">Your response</label>
      <textarea id="topic-reply" bind:value={text} oninput={() => draftRevision += 1} maxlength="300" rows="5" placeholder="Contribute to this topic."></textarea>
      <div class="composer-actions"><button class="button button-secondary" type="button" onclick={closeReply}>Cancel</button><button class="button button-primary" type="submit" disabled={posting || !text.trim()}>{posting ? 'Posting…' : 'Post reply'}</button></div>
      {#if replyError}<p class="composer-message" role="alert">{replyError}</p>{/if}
    </form>
  </dialog>
{/if}

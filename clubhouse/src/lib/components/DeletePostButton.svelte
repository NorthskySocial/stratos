<script lang="ts">
  import type { ClubhouseFeedPost } from '../feedgen'

  interface Props {
    post: ClubhouseFeedPost
    noun: 'topic' | 'reply'
    onDelete: (post: ClubhouseFeedPost) => Promise<void>
  }

  let { post, noun, onDelete }: Props = $props()
  let confirming = $state(false)
  let deleting = $state(false)
  let error = $state('')

  async function deletePost() {
    deleting = true
    error = ''
    try {
      await onDelete(post)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Post could not be deleted'
    } finally {
      deleting = false
    }
  }
</script>

<span class="delete-control">
  {#if confirming}
    <span class="delete-question">Delete {noun}?</span>
    <button class="delete-confirm" type="button" disabled={deleting} onclick={() => void deletePost()}>{deleting ? 'Deleting…' : 'Delete now'}</button>
    <button class="delete-cancel" type="button" disabled={deleting} onclick={() => { confirming = false; error = '' }}>Keep</button>
  {:else}
    <button class="delete-trigger" type="button" onclick={() => confirming = true}>Delete</button>
  {/if}
  {#if error}<span class="delete-error" role="alert">{error}</span>{/if}
</span>

<style>
  .delete-control {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .delete-control button {
    min-height: 2.35rem;
    border: 0;
    background: transparent;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 750;
    cursor: pointer;
  }

  .delete-trigger,
  .delete-confirm {
    color: #b92840;
  }

  .delete-control .delete-confirm {
    padding: 0.35rem 0.6rem;
    border: 2px solid #20301f;
    border-radius: 0.45rem;
    color: #fff;
    background: #d9374f;
    box-shadow: 2px 2px 0 #20301f;
  }

  .delete-cancel {
    color: #20301f;
  }

  .delete-question {
    color: #82283a;
    font-size: 0.78rem;
    font-weight: 700;
  }

  .delete-error {
    flex-basis: 100%;
    color: #82283a;
    font-size: 0.75rem;
    line-height: 1.35;
    text-align: right;
  }

  .delete-control button:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  @media (max-width: 680px) {
    .delete-control button {
      min-height: 2.75rem;
    }
  }
</style>

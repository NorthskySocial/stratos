<script lang="ts">
  import IconaMoon from './IconaMoon.svelte'

  interface Props {
    message?: string
    onRetry?: () => void
  }

  let { message = 'The room list is taking a moment to respond.', onRetry }: Props = $props()
</script>

<section class="error-state" aria-labelledby="catalog-error-title" role="alert">
  <div class="error-icon"><IconaMoon name="information" /></div>
  <div>
    <h2 id="catalog-error-title">Rooms are temporarily out of reach</h2>
    <p>{message} Check your connection and try again.</p>
    {#if onRetry}
      <button class="button button-secondary" type="button" onclick={onRetry}>Try again</button>
    {/if}
  </div>
</section>

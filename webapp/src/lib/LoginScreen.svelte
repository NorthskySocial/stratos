<script lang="ts">
  import { signIn } from './auth'

  let handle = $state('')
  let loading = $state(false)
  let error = $state('')

  async function handleSubmit(e: Event) {
    e.preventDefault()
    if (!handle.trim()) return

    loading = true
    error = ''
    try {
      await signIn(handle.trim())
    } catch (err) {
      error = err instanceof Error ? err.message : 'Sign in failed'
      loading = false
    }
  }
</script>

<div class="login-screen">
  <div class="login-card">
    <h1>Stratos</h1>
    <p class="subtitle">Private data for ATProto</p>

    <form onsubmit={handleSubmit} aria-busy={loading}>
      <label for="handle">Bluesky handle</label>
      <input
        id="handle"
        type="text"
        bind:value={handle}
        placeholder="Enter your handle (e.g. alice.bsky.social)"
        disabled={loading}
        autocomplete="username"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'sign-in-error' : 'handle-help'}
      />
      <p id="handle-help" class="help">Use the handle for the account you want to sign in with.</p>
      <button type="submit" disabled={loading || !handle.trim()}>
        {loading ? 'Signing in…' : 'Sign In'}
      </button>
    </form>

    <p class="sr-only" role="status">{loading ? 'Signing in' : ''}</p>

    {#if error}
      <p id="sign-in-error" class="error" role="alert">{error}</p>
    {/if}
  </div>
</div>

<style>
  .login-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }

  .login-card {
    width: 100%;
    max-width: 380px;
    padding: 2rem;
  }

  h1 {
    margin: 0 0 0.25rem;
    font-size: 1.75rem;
  }

  .subtitle {
    margin: 0 0 1.5rem;
    color: #666;
    font-size: 0.9rem;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  input {
    padding: 0.6rem 0.75rem;
    border: 1px solid #ccc;
    border-radius: 6px;
    font-size: 0.95rem;
  }

  input:focus {
    outline: none;
    border-color: #0066ff;
    box-shadow: 0 0 0 2px rgba(0, 102, 255, 0.15);
  }

  input:focus-visible,
  button:focus-visible {
    outline: 3px solid #1d4ed8;
    outline-offset: 2px;
  }

  .help {
    margin: -0.4rem 0 0;
    color: #666;
    font-size: 0.8rem;
  }

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

  button {
    padding: 0.6rem;
    background: #0066ff;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.95rem;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button:not(:disabled):hover {
    background: #0052cc;
  }

  .error {
    margin-top: 0.75rem;
    color: #cc0000;
    font-size: 0.85rem;
  }
</style>

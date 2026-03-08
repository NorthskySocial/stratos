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
    <div class="sparkle-divider">✦ ✧ ✦ ✧ ✦ ✧ ✦ ✧ ✦ ✧ ✦</div>
    <h1 class="title">~*~StRaToS~*~</h1>
    <p class="subtitle">ur private data 4 ATProto <span class="heart">&hearts;</span></p>
    <div class="sparkle-divider">✦ ✧ ✦ ✧ ✦ ✧ ✦ ✧ ✦ ✧ ✦</div>

    <form onsubmit={handleSubmit}>
      <label class="input-label">eNtEr Ur HaNdLe:</label>
      <input
        type="text"
        bind:value={handle}
        placeholder="alice.bsky.social"
        disabled={loading}
      />
      <button type="submit" disabled={loading || !handle.trim()}>
        {loading ? '~*~ SiGnInG iN... ~*~' : '~*~ SiGn In ~*~'}
      </button>
    </form>

    {#if error}
      <p class="error">!! {error} !!</p>
    {/if}

    <div class="tom-note">
      <span class="tom-emoji">😎</span>
      <span>Tom added u as a friend!</span>
    </div>

    <div class="sparkle-divider bottom">★ ☆ ★ ☆ ★ ☆ ★ ☆ ★ ☆ ★</div>
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
    max-width: 420px;
    padding: 2rem;
    background: #0a0020;
    border: 3px solid #ff00ff;
    border-radius: 12px;
    box-shadow: 0 0 20px #ff00ff66, 0 0 40px #ff00ff22, inset 0 0 20px #ff00ff11;
    text-align: center;
  }

  .title {
    margin: 0.5rem 0 0.25rem;
    font-size: 2.5rem;
    font-weight: bold;
    animation: rainbow 3s linear infinite;
    text-shadow: 0 0 10px currentColor;
  }

  .subtitle {
    margin: 0 0 0.5rem;
    color: #ff69b4;
    font-size: 1rem;
  }

  .heart {
    color: #ff0066;
    animation: blink 1s step-end infinite;
    font-size: 1.2em;
  }

  .sparkle-divider {
    color: #ffff00;
    font-size: 0.7rem;
    letter-spacing: 0.15em;
    animation: rainbow 4s linear infinite;
    opacity: 0.8;
    margin: 0.5rem 0;
  }

  .sparkle-divider.bottom {
    margin-top: 1rem;
  }

  .input-label {
    display: block;
    color: #00ffff;
    font-size: 0.85rem;
    font-weight: bold;
    text-align: left;
    margin-bottom: 0.3rem;
    text-shadow: 0 0 4px #00ffff;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin-top: 1rem;
  }

  input {
    padding: 0.7rem 0.75rem;
    border: 2px solid #8b00ff;
    border-radius: 6px;
    font-size: 0.95rem;
    font-family: inherit;
    background: #1a0030;
    color: #00ffff;
    caret-color: #00ffff;
  }

  input::placeholder {
    color: #666;
  }

  input:focus {
    outline: none;
    border-color: #ff00ff;
    box-shadow: 0 0 8px #ff00ff88, 0 0 16px #ff00ff44;
  }

  button {
    padding: 0.7rem;
    background: linear-gradient(135deg, #ff00ff, #8b00ff, #ff69b4);
    background-size: 200% 200%;
    animation: gradient-move 3s ease infinite;
    color: #fff;
    border: 2px solid #ff69b4;
    border-radius: 6px;
    font-size: 1rem;
    font-weight: bold;
    font-family: inherit;
    cursor: pointer;
    text-shadow: 0 0 6px #fff;
    box-shadow: 0 0 10px #ff00ff66;
  }

  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  button:not(:disabled):hover {
    box-shadow: 0 0 20px #ff00ff, 0 0 30px #ff00ff88;
    text-shadow: 0 0 10px #fff;
  }

  .error {
    margin-top: 0.75rem;
    color: #ff4444;
    font-size: 0.85rem;
    text-shadow: 0 0 4px #ff4444;
    animation: blink 1.5s step-end infinite;
  }

  .tom-note {
    margin-top: 1rem;
    padding: 0.5rem;
    border: 1px dashed #ffff00;
    border-radius: 6px;
    color: #ffff00;
    font-size: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    justify-content: center;
    animation: float 2s ease-in-out infinite;
  }

  .tom-emoji {
    font-size: 1.2rem;
  }

  @keyframes rainbow {
    0% { color: #ff0000; }
    16% { color: #ff8800; }
    33% { color: #ffff00; }
    50% { color: #00ff00; }
    66% { color: #0088ff; }
    83% { color: #8800ff; }
    100% { color: #ff0000; }
  }

  @keyframes blink {
    50% { opacity: 0; }
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-3px); }
  }

  @keyframes gradient-move {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
</style>

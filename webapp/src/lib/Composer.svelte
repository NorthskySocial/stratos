<script lang="ts">
  import { Agent } from '@atproto/api'
  import type { OAuthSession } from '@atproto/oauth-client-browser'
  import type { StratosEnrollment } from './stratos'

  interface Props {
    session: OAuthSession
    enrollment: StratosEnrollment | null
    stratosAgent: Agent | null
    onpost: () => void
  }

  let { session, enrollment, stratosAgent, onpost }: Props = $props()

  let text = $state('')
  let isPrivate = $state(false)
  let posting = $state(false)
  let error = $state('')

  async function handlePost() {
    if (!text.trim()) return
    posting = true
    error = ''

    try {
      const now = new Date().toISOString()

      if (isPrivate && stratosAgent) {
        await stratosAgent.com.atproto.repo.createRecord({
          repo: session.sub,
          collection: 'zone.stratos.feed.post',
          record: {
            $type: 'zone.stratos.feed.post',
            text: text.trim(),
            boundary: {
              $type: 'zone.stratos.boundary.defs#Domains',
              values: enrollment?.boundaries ?? [],
            },
            createdAt: now,
          },
        })
      } else {
        const agent = new Agent(session)
        await agent.com.atproto.repo.createRecord({
          repo: session.sub,
          collection: 'app.bsky.feed.post',
          record: {
            $type: 'app.bsky.feed.post',
            text: text.trim(),
            createdAt: now,
          },
        })
      }

      text = ''
      onpost()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create post'
    } finally {
      posting = false
    }
  }
</script>

<div class="composer">
  <div class="composer-header">✧ LeAvE a CoMmEnT!! ✧</div>

  <textarea
    bind:value={text}
    placeholder={isPrivate ? '~*~ write a sEcReT message... ~*~' : '~*~ wHaTs oN uR mInD?? ~*~'}
    disabled={posting}
    rows="3"
  ></textarea>

  <div class="composer-actions">
    <label class="private-toggle" class:disabled={!enrollment}>
      <input
        type="checkbox"
        bind:checked={isPrivate}
        disabled={!enrollment || posting}
      />
      <span>{isPrivate ? '🔒 pRiVaTe' : '🌐 pUbLiC'}</span>
      {#if !enrollment}
        <span class="tooltip">eNrOLL iN sTrAtOs 2 pOsT pRiVaTeLy!!</span>
      {/if}
    </label>

    <button onclick={handlePost} disabled={posting || !text.trim()}>
      {posting ? '~*~ pOsTiNg... ~*~' : '~*~ PoSt iT ~*~'}
    </button>
  </div>

  {#if error}
    <p class="error">!! {error} !!</p>
  {/if}
</div>

<style>
  .composer {
    padding: 0.75rem;
    border: 2px solid #ff00ff44;
    border-radius: 8px;
    background: linear-gradient(180deg, #1a003088, #0a001a88);
    margin-bottom: 0.75rem;
  }

  .composer-header {
    text-align: center;
    color: #ffff00;
    font-size: 0.85rem;
    font-weight: bold;
    text-shadow: 0 0 8px #ffff00;
    margin-bottom: 0.5rem;
    animation: rainbow 4s linear infinite;
  }

  textarea {
    width: 100%;
    padding: 0.6rem 0.75rem;
    border: 2px solid #00ffff44;
    border-radius: 6px;
    font-size: 0.85rem;
    font-family: inherit;
    resize: vertical;
    box-sizing: border-box;
    background: #0a0020;
    color: #00ff00;
    text-shadow: 0 0 4px #00ff0066;
  }

  textarea::placeholder {
    color: #00ff0066;
  }

  textarea:focus {
    outline: none;
    border-color: #ff00ff;
    box-shadow: 0 0 10px #ff00ff66;
  }

  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.5rem;
  }

  .private-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    cursor: pointer;
    position: relative;
    color: #ccc;
  }

  .private-toggle.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .private-toggle input:checked + span {
    color: #ff69b4;
    font-weight: bold;
    text-shadow: 0 0 4px #ff69b4;
  }

  .tooltip {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 0;
    background: #1a0030;
    color: #ff69b4;
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    border: 1px solid #ff00ff44;
    font-size: 0.7rem;
    white-space: nowrap;
    margin-bottom: 0.3rem;
  }

  .private-toggle.disabled:hover .tooltip {
    display: block;
  }

  button {
    padding: 0.45rem 1rem;
    background: linear-gradient(135deg, #ff00ff, #8b00ff, #ff69b4);
    color: white;
    border: 2px solid #ff69b4;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: bold;
    font-family: inherit;
    cursor: pointer;
    text-shadow: 0 0 4px #fff;
    box-shadow: 0 0 8px #ff00ff44;
  }

  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  button:not(:disabled):hover {
    box-shadow: 0 0 16px #ff00ff, 0 0 24px #ff00ff88;
  }

  .error {
    margin-top: 0.5rem;
    color: #ff4444;
    font-size: 0.75rem;
    text-shadow: 0 0 4px #ff444466;
  }

  @keyframes rainbow {
    0% { color: #ff0000; }
    16% { color: #ff8800; }
    33% { color: #ffff00; }
    50% { color: #00ff00; }
    66% { color: #0088ff; }
    83% { color: #ff00ff; }
    100% { color: #ff0000; }
  }
</style>

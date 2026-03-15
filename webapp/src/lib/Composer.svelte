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
  let selectedDomain = $state('')
  let posting = $state(false)
  let error = $state('')

  let domains = $derived(
    enrollment?.boundaries.map((b) => b.value).filter(Boolean) ?? [],
  )

  $effect(() => {
    if (domains.length > 0 && !selectedDomain) {
      selectedDomain = domains[0]
    }
  })

  async function handlePost() {
    if (!text.trim()) return
    posting = true
    error = ''

    try {
      const now = new Date().toISOString()

      if (isPrivate && stratosAgent && selectedDomain) {
        await stratosAgent.com.atproto.repo.createRecord({
          repo: session.sub,
          collection: 'zone.stratos.feed.post',
          record: {
            $type: 'zone.stratos.feed.post',
            text: text.trim(),
            boundary: {
              $type: 'zone.stratos.boundary.defs#Domains',
              values: [{ value: selectedDomain }],
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
  <textarea
    bind:value={text}
    placeholder={isPrivate ? `Post to ${selectedDomain || 'private'}…` : 'Write a post…'}
    disabled={posting}
    rows="3"
  ></textarea>

  <div class="composer-actions">
    <div class="left-actions">
      <label class="private-toggle" class:disabled={!enrollment}>
        <input
          type="checkbox"
          bind:checked={isPrivate}
          disabled={!enrollment || posting}
        />
        <span>Private</span>
        {#if !enrollment}
          <span class="tooltip">Enroll in Stratos to post privately</span>
        {/if}
      </label>

      {#if isPrivate && domains.length > 0}
        <select
          class="domain-select"
          bind:value={selectedDomain}
          disabled={posting}
        >
          {#each domains as domain}
            <option value={domain}>{domain}</option>
          {/each}
        </select>
      {/if}
    </div>

    <button onclick={handlePost} disabled={posting || !text.trim()}>
      {posting ? 'Posting…' : 'Post'}
    </button>
  </div>

  {#if error}
    <p class="error">{error}</p>
  {/if}
</div>

<style>
  .composer {
    padding: 1rem;
    border-bottom: 1px solid #eee;
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

  .tooltip {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 0;
    background: #333;
    color: white;
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    white-space: nowrap;
    margin-bottom: 0.3rem;
  }

  .private-toggle.disabled:hover .tooltip {
    display: block;
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

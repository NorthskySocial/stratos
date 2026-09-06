<script lang="ts">
  import { onDestroy } from 'svelte'
  import { searchActors, type TypeaheadActor } from '../typeahead'

  interface Props {
    value?: string
    disabled?: boolean
  }

  let { value = $bindable(''), disabled = false }: Props = $props()
  let results = $state<TypeaheadActor[]>([])
  let open = $state(false)
  let searching = $state(false)
  let activeIndex = $state(-1)
  let debounceTimer: number | undefined
  let request: AbortController | undefined
  let searchVersion = 0

  onDestroy(() => {
    window.clearTimeout(debounceTimer)
    request?.abort()
  })

  function dismissResults() {
    searchVersion += 1
    window.clearTimeout(debounceTimer)
    request?.abort()
    request = undefined
    searching = false
    open = false
    activeIndex = -1
  }

  function queueSearch() {
    const version = ++searchVersion
    window.clearTimeout(debounceTimer)
    request?.abort()
    activeIndex = -1
    const query = value.trim()
    if (query.length < 2) {
      results = []
      open = false
      searching = false
      return
    }

    searching = true
    debounceTimer = window.setTimeout(async () => {
      request = new AbortController()
      try {
        const nextResults = await searchActors(query, globalThis.fetch, request.signal)
        if (version === searchVersion) {
          results = nextResults
          open = results.length > 0
        }
      } catch (error) {
        if (
          version === searchVersion &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) {
          results = []
          open = false
        }
      } finally {
        if (version === searchVersion) searching = false
      }
    }, 180)
  }

  function choose(actor: TypeaheadActor) {
    dismissResults()
    value = actor.handle
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      dismissResults()
      return
    }
    if (event.key === 'Tab') {
      open = false
      return
    }
    if (!open || results.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeIndex = (activeIndex + 1) % results.length
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      activeIndex = (activeIndex - 1 + results.length) % results.length
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault()
      const actor = results[activeIndex]
      if (actor) choose(actor)
    }
  }

  function handleBlur(event: FocusEvent) {
    const next = event.relatedTarget
    if (next instanceof Element && next.closest('#handle-suggestions')) return
    dismissResults()
  }

</script>

<div class="handle-typeahead">
  <input
    id="handle"
    bind:value
    {disabled}
    autocomplete="off"
    autocapitalize="none"
    autocorrect="off"
    spellcheck="false"
    placeholder="rei.example"
    role="combobox"
    aria-autocomplete="list"
    aria-controls="handle-suggestions"
    aria-expanded={open}
    aria-busy={searching}
    aria-activedescendant={activeIndex >= 0 ? `handle-result-${activeIndex}` : undefined}
    oninput={queueSearch}
    onkeydown={handleKeydown}
    onfocus={() => open = results.length > 0}
    onblur={handleBlur}
  />
  {#if open}
    <div id="handle-suggestions" class="handle-suggestions" role="listbox" aria-label="ATProto accounts">
      {#each results as actor, index (actor.did)}
        <button
          id={`handle-result-${index}`}
          class:active={index === activeIndex}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onpointerdown={() => choose(actor)}
          onclick={() => choose(actor)}
        >
          {#if actor.avatar}
            <img src={actor.avatar} alt="" loading="lazy" referrerpolicy="no-referrer" />
          {:else}
            <span class="avatar-fallback" aria-hidden="true">{actor.displayName?.[0] ?? actor.handle[0]}</span>
          {/if}
          <span class="typeahead-result-copy"><strong>{actor.displayName ?? actor.handle}</strong><small>@{actor.handle}</small></span>
        </button>
      {/each}
    </div>
  {:else if searching}
    <span class="typeahead-status" aria-live="polite">Finding accounts…</span>
  {/if}
</div>

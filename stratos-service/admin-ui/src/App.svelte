<script lang="ts">
  import Router, { router } from 'svelte-spa-router'
  import { onMount, setContext, tick } from 'svelte'
  import {
    BOUNDARY_NAVIGATION,
    type BoundaryNavigation,
    type BoundaryNavigationGuard,
  } from './lib/boundary-workspace'
  import {
    auth,
    refreshAuth,
    setUnauthenticated,
  } from './lib/stores/auth.svelte'
  import { logout } from './lib/api/client'
  import Logo from './lib/components/ui/Logo.svelte'
  import Identity from './lib/components/ui/Identity.svelte'
  import ThemeToggle from './lib/components/ui/ThemeToggle.svelte'
  import Login from './routes/Login.svelte'
  import Health from './routes/Health.svelte'
  import Boundaries from './routes/Boundaries.svelte'
  import Enrollments from './routes/Enrollments.svelte'
  import Admins from './routes/Admins.svelte'

  const guards = new Set<BoundaryNavigationGuard>()
  let attempted = $state<{ href: string; index: number; source: 'link' | 'history' } | 'logout' | null>(null)
  let stayButton = $state<HTMLButtonElement>()
  let previousFocus: HTMLElement | null = null
  const historyKey = '__stratos_boundary_entry'
  const storedIndex: unknown = history.state?.[historyKey]
  let currentIndex = typeof storedIndex === 'number' ? storedIndex : 0
  let accepted = $state({ href: window.location.href, index: currentIndex })
  const acceptedRoute = $derived.by(() => {
    const hash = new URL(accepted.href).hash.slice(1) || '/'
    const separator = hash.indexOf('?')
    return { location: separator < 0 ? hash : hash.slice(0, separator), querystring: separator < 0 ? '' : hash.slice(separator + 1) }
  })
  const boundaryRoutes = ['/boundaries', '/boundaries/detail', '/domains']
  let restoring = false

  setContext<BoundaryNavigation>(BOUNDARY_NAVIGATION, {
    register(next) {
      guards.add(next)
      return () => { guards.delete(next) }
    },
  })

  function dirty() {
    return auth.status === 'authenticated' && [...guards].some((entry) => entry.isDirty())
  }

  async function prompt(destination: NonNullable<typeof attempted>) {
    if (attempted) return
    previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    attempted = destination
    await tick()
    stayButton?.focus()
  }

  function stamp(index: number) {
    history.replaceState({ ...history.state, [historyKey]: index }, '')
  }

  function restoreAccepted() {
    if (currentIndex === accepted.index) {
      restoring = false
      return
    }
    restoring = true
    history.go(accepted.index - currentIndex)
  }

  function historyNavigation() {
    const storedIndex: unknown = history.state?.[historyKey]
    currentIndex = typeof storedIndex === 'number' ? storedIndex : currentIndex + 1
    if (typeof storedIndex !== 'number') stamp(currentIndex)
    if (attempted || dirty()) {
      if (window.location.href !== accepted.href) {
        void prompt({ href: window.location.href, index: currentIndex, source: 'history' })
      }
      restoreAccepted()
    } else {
      accepted = { href: window.location.href, index: currentIndex }
    }
  }

  function gateHash(event: Event) {
    if (event instanceof HashChangeEvent && event.newURL !== window.location.href) {
      event.stopImmediatePropagation()
      return
    }
    const renderedHash = `#${router.location}${router.querystring ? `?${router.querystring}` : ''}`
    if (window.location.hash === renderedHash) {
      event.stopImmediatePropagation()
      return
    }
    if (attempted || restoring) {
      event.stopImmediatePropagation()
      return
    }
    if (window.location.href !== accepted.href) historyNavigation()
    if (attempted || restoring) event.stopImmediatePropagation()
  }

  function navigate(href: string) {
    history.pushState({ ...history.state, [historyKey]: ++currentIndex }, '', href)
    accepted = { href: window.location.href, index: currentIndex }
    window.dispatchEvent(new Event('hashchange'))
  }

  function interceptLink(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey ||
      event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = event.target instanceof Element ? event.target.closest('a') : null
    if (!anchor || anchor.hasAttribute('download') ||
      (anchor.target && anchor.target !== '_self')) return
    const destination = new URL(anchor.href)
    if (destination.origin !== location.origin || destination.pathname !== location.pathname ||
      destination.search !== location.search || !destination.hash.startsWith('#/')) return
    event.preventDefault()
    if (!dirty() && !attempted) {
      if (destination.href !== accepted.href) navigate(destination.href)
      return
    }
    if (destination.href !== accepted.href) {
      void prompt({ href: destination.href, index: accepted.index + 1, source: 'link' })
    }
  }

  function stay() {
    if (restoring) return
    attempted = null
    previousFocus?.focus()
  }

  function discard() {
    if (!attempted || restoring) return
    const destination = attempted
    for (const entry of guards) entry.discard()
    attempted = null
    if (destination === 'logout') void performLogout()
    else if (destination.source === 'link') {
      navigate(destination.href)
    } else {
      history.go(destination.index - currentIndex)
    }
  }

  onMount(() => {
    stamp(currentIndex)
    window.addEventListener('popstate', historyNavigation)
    window.addEventListener('hashchange', gateHash, true)
    document.addEventListener('click', interceptLink, true)
    return () => {
      window.removeEventListener('popstate', historyNavigation)
      window.removeEventListener('hashchange', gateHash, true)
      document.removeEventListener('click', interceptLink, true)
    }
  })

  $effect(() => {
    if (auth.status !== 'authenticated') attempted = null
  })

  const routes = {
    '/': Health,
    '/health': Health,
    '/enrollments': Enrollments,
    '/admins': Admins,
  }

  const nav = [
    { href: '#/health', label: 'Health', match: ['/', '/health'] },
    {
      href: '#/boundaries',
      label: 'Boundaries',
      match: ['/boundaries', '/boundaries/detail', '/domains'],
    },
    { href: '#/enrollments', label: 'Enrollments', match: ['/enrollments'] },
    { href: '#/admins', label: 'Admins', match: ['/admins'] },
  ]

  $effect(() => {
    void refreshAuth()
  })

  function handleLogout() {
    if (dirty()) void prompt('logout')
    else void performLogout()
  }

  async function performLogout() {
    try {
      await logout()
    } finally {
      setUnauthenticated()
    }
  }
</script>

{#if auth.status === 'loading'}
  <main class="flex min-h-screen items-center justify-center">
    <p class="text-muted">Connecting…</p>
  </main>
{:else if auth.status === 'unauthenticated'}
  <Login />
{:else}
  <div
    class="mx-auto flex min-h-dvh w-full max-w-4xl flex-col px-5 pb-16"
    data-testid="admin-shell"
  >
    <header class="flex flex-wrap items-center justify-between gap-3 py-4">
      <Logo />
      <div class="flex items-center gap-3">
        <span class="text-sm text-muted" data-testid="whoami-did">
          <Identity did={auth.did ?? ''} />
        </span>
        <ThemeToggle />
        <button
          class="pill squish cursor-pointer px-4 py-1 text-sm font-semibold"
          data-testid="logout"
          onclick={handleLogout}
          type="button"
        >
          Sign out
        </button>
      </div>
    </header>

    <nav aria-label="Administration" class="flex flex-wrap gap-2 pb-6">
      {#each nav as item (item.href)}
        <a
          class="squish px-4 py-1.5 text-sm no-underline {item.match.includes(
            acceptedRoute.location,
          )
            ? 'grad-fill font-bold'
            : 'pill font-medium'}"
          href={item.href}
        >
          {item.label}
        </a>
      {/each}
    </nav>

    {#if attempted}
      <div tabindex="-1" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" class="mb-6 rounded-2xl bg-bubble p-5" data-testid="navigation-confirmation">
        <h2 id="discard-title" class="font-display text-lg">Discard unsaved changes?</h2>
        <p class="mt-2 text-sm">Your draft has not been saved. Stay to keep it, or discard it and continue.</p>
        <div class="mt-4 flex gap-3">
          <button bind:this={stayButton} type="button" class="pill squish px-4 py-2" onclick={stay}>Stay</button>
          <button type="button" class="pill squish px-4 py-2" onclick={discard}>Discard</button>
        </div>
      </div>
    {/if}

    <main class="grow" inert={attempted !== null}>
      {#if boundaryRoutes.includes(acceptedRoute.location)}
        <Boundaries route={acceptedRoute} />
      {:else}
        <Router {routes} />
      {/if}
    </main>
  </div>
{/if}

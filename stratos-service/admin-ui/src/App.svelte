<script lang="ts">
  import Router, { router } from 'svelte-spa-router'
  import { auth, refreshAuth, setUnauthenticated } from './lib/stores/auth.svelte'
  import { logout } from './lib/api/client'
  import Logo from './lib/components/ui/Logo.svelte'
  import Identity from './lib/components/ui/Identity.svelte'
  import ThemeToggle from './lib/components/ui/ThemeToggle.svelte'
  import Login from './routes/Login.svelte'
  import Health from './routes/Health.svelte'
  import Domains from './routes/Domains.svelte'
  import Enrollments from './routes/Enrollments.svelte'

  const routes = {
    '/': Health,
    '/health': Health,
    '/domains': Domains,
    '/enrollments': Enrollments,
  }

  const nav = [
    { href: '#/health', label: 'Health', match: ['/', '/health'] },
    { href: '#/domains', label: 'Domains', match: ['/domains'] },
    { href: '#/enrollments', label: 'Enrollments', match: ['/enrollments'] },
  ]

  $effect(() => {
    void refreshAuth()
  })

  async function handleLogout() {
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
    <header class="flex items-center justify-between py-4">
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

    <nav class="flex gap-2 pb-6">
      {#each nav as item (item.href)}
        <a
          class="squish px-4 py-1.5 text-sm no-underline {item.match.includes(
            router.location,
          )
            ? 'grad-fill font-bold'
            : 'pill font-medium'}"
          href={item.href}
        >
          {item.label}
        </a>
      {/each}
    </nav>

    <main class="grow">
      <Router {routes} />
    </main>
  </div>
{/if}

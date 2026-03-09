<script lang="ts">
  import { onMount } from 'svelte'
  import { Agent } from '@atproto/api'
  import type { OAuthSession } from '@atproto/oauth-client-browser'
  import { init, signOut } from './lib/auth'
  import { discoverStratosEnrollment, STRATOS_URL, type StratosEnrollment } from './lib/stratos'
  import { createStratosAgent } from './lib/stratos-agent'
  import { fetchPublicPosts, fetchStratosPosts, buildUnifiedFeed, type FeedPost } from './lib/feed'
  import LoginScreen from './lib/LoginScreen.svelte'
  import EnrollmentIndicator from './lib/EnrollmentIndicator.svelte'
  import Composer from './lib/Composer.svelte'
  import Feed from './lib/Feed.svelte'

  let session: OAuthSession | null = $state(null)
  let enrollment: StratosEnrollment | null = $state(null)
  let stratosAgent: Agent | null = $state(null)
  let posts: FeedPost[] = $state([])
  let loading = $state(true)
  let handle = $state('')
  let serviceUrl = $state(STRATOS_URL ?? '')

  async function startup() {
    loading = true
    try {
      session = await init()
      if (session) {
        handle = session.sub
        await discoverAndLoad()
      }
    } catch (err) {
      console.error('Init failed:', err)
    } finally {
      loading = false
    }
  }

  async function discoverAndLoad() {
    if (!session) return

    enrollment = await discoverStratosEnrollment(session)

    const url = enrollment?.service ?? serviceUrl
    if (url) {
      serviceUrl = url
      stratosAgent = createStratosAgent(session, url)
    }

    await refreshFeed()
  }

  async function refreshFeed() {
    if (!session) return

    const pdsAgent = new Agent(session)
    const publicPosts = await fetchPublicPosts(pdsAgent, session.sub)

    let stratosPosts: FeedPost[] = []
    if (stratosAgent) {
      stratosPosts = await fetchStratosPosts(stratosAgent, session.sub)
    }

    posts = buildUnifiedFeed(publicPosts, stratosPosts)
  }

  async function handleSignOut() {
    await signOut()
    session = null
    enrollment = null
    stratosAgent = null
    posts = []
    handle = ''
  }

  onMount(() => {
    startup()
  })
</script>

{#if loading && !session}
  <div class="loading-screen">Loading…</div>
{:else if !session}
  <LoginScreen />
{:else}
  <div class="app-layout">
    <aside class="sidebar">
      <EnrollmentIndicator {handle} {enrollment} {serviceUrl} />
      <button class="sign-out" onclick={handleSignOut}>Sign Out</button>
    </aside>

    <main class="main">
      <header class="app-header">
        <h1>Stratos</h1>
      </header>

      <Composer {session} {enrollment} {stratosAgent} onpost={refreshFeed} />
      <Feed {posts} loading={loading} />
    </main>
  </div>
{/if}

<style>
  .loading-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    color: #888;
  }

  .app-layout {
    display: flex;
    min-height: 100vh;
  }

  .sidebar {
    width: 260px;
    border-right: 1px solid #eee;
    display: flex;
    flex-direction: column;
  }

  .sign-out {
    margin: auto 1rem 1rem;
    padding: 0.45rem;
    background: none;
    border: 1px solid #ccc;
    border-radius: 6px;
    color: #666;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .sign-out:hover {
    background: #f5f5f5;
    color: #333;
  }

  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    max-width: 600px;
  }

  .app-header {
    padding: 1rem;
    border-bottom: 1px solid #eee;
  }

  .app-header h1 {
    margin: 0;
    font-size: 1.25rem;
  }
</style>

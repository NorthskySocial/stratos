<script lang="ts">
  import { onMount, setContext } from 'svelte'
  import { Agent } from '@atproto/api'
  import type { OAuthSession } from '@atproto/oauth-client-browser'
  import { init, signOut, onSessionDeleted } from './lib/auth'
  import {
    discoverStratosEnrollment,
    checkStratosServiceStatus,
    verifyAttestation,
    fetchServerDomains,
    STRATOS_URL,
    APPVIEW_URL,
    type StratosEnrollment,
    type StratosServiceStatus,
  } from './lib/stratos'
  import { createServiceAgent, createStratosAgent } from './lib/stratos-agent'
  import {
    fetchPublicPosts,
    fetchRepoPublicPosts,
    fetchStratosPosts,
    fetchAppviewStratosPosts,
    buildUnifiedFeed,
    filterByDomain,
    feedStats,
    resolveHandles,
    type FeedPost,
  } from './lib/feed'
  import underConstruction from './assets/under-construction.gif'
  import LoginScreen from './lib/LoginScreen.svelte'
  import Sidebar from './lib/Sidebar.svelte'
  import Composer from './lib/Composer.svelte'
  import Feed from './lib/Feed.svelte'
  import { displayBoundary } from './lib/boundary-display'

  let session: OAuthSession | null = $state(null)
  let enrollment: StratosEnrollment | null = $state(null)
  let stratosStatus: StratosServiceStatus | null = $state(null)
  let attestationVerified: boolean | null = $state(null)
  let appviewAgent: Agent | null = $state(null)
  let stratosAgent: Agent | null = $state(null)
  let allPosts: FeedPost[] = $state([])
  let replyingTo: FeedPost | null = $state(null)
  let loading = $state(true)
  let did = $state('')
  let handle = $state('')
  let serviceUrl = $state(STRATOS_URL ?? '')
  let activeFeed: string | null = $state(null)
  let serverDomains: string[] = $state([])

  const inspectorCtx = { session: null as OAuthSession | null, serviceUrl: '' }
  setContext('stratos-inspector', inspectorCtx)

  $effect(() => {
    inspectorCtx.session = session
    inspectorCtx.serviceUrl = serviceUrl
  })

  let enrolledDomains = $derived(
    enrollment?.boundaries.map((b) => b.value).filter(Boolean) ?? [],
  )

  let allDomains = $derived(
    Array.from(
      new Set([...serverDomains, ...enrolledDomains]),
    ).sort(),
  )

  let filteredPosts = $derived(filterByDomain(allPosts, activeFeed))
  let stats = $derived(feedStats(filteredPosts))

  async function startup() {
    loading = true
    try {
      session = await init()
      if (session) {
        did = session.sub
        const agent = new Agent(session)
        const profile = await agent.com.atproto.repo.describeRepo({ repo: session.sub })
        handle = profile.data.handle
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

    if (APPVIEW_URL) {
      appviewAgent = createServiceAgent(session, APPVIEW_URL)
    }

    enrollment = await discoverStratosEnrollment(session)

    const url = enrollment?.service ?? serviceUrl
    if (url) {
      serviceUrl = url
      stratosAgent = createStratosAgent(session, url)

      stratosStatus = await checkStratosServiceStatus(url, session.sub)
      serverDomains = await fetchServerDomains(url)
    }

    if (enrollment) {
      attestationVerified = await verifyAttestation(session.sub, enrollment)
    } else {
      attestationVerified = null
    }

    await refreshFeed()
  }

  async function refreshFeed() {
    if (!session) return

    const publicPosts = appviewAgent
      ? await fetchPublicPosts(appviewAgent, session.sub)
      : await fetchRepoPublicPosts(new Agent(session), session.sub)

    let stratosPosts: FeedPost[] = []
    if (APPVIEW_URL) {
      stratosPosts = await fetchAppviewStratosPosts(
        session,
        APPVIEW_URL,
      )
    } else if (stratosAgent) {
      stratosPosts = await fetchStratosPosts(stratosAgent, session.sub)
    }

    const unified = buildUnifiedFeed(publicPosts, stratosPosts)
    allPosts = resolveHandles(unified, did, handle)
  }

  function handleSelectFeed(domain: string | null) {
    activeFeed = domain
  }

  function handleReply(post: FeedPost) {
    replyingTo = post
  }

  function cancelReply() {
    replyingTo = null
  }

  async function handleSignOut() {
    await signOut()
    session = null
    enrollment = null
    stratosStatus = null
    attestationVerified = null
    appviewAgent = null
    stratosAgent = null
    allPosts = []
    handle = ''
    did = ''
    activeFeed = null
  }

  onMount(() => {
    onSessionDeleted(() => {
      session = null
      enrollment = null
      stratosStatus = null
      attestationVerified = null
      appviewAgent = null
      stratosAgent = null
      allPosts = []
      handle = ''
      did = ''
      activeFeed = null
    })
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
      <Sidebar
        {handle}
        {enrollment}
        {serviceUrl}
        {stratosStatus}
        {attestationVerified}
        {allDomains}
        {enrolledDomains}
        postCount={stats.postCount}
        userCount={stats.userCount}
        {activeFeed}
        onSelectFeed={handleSelectFeed}
      />
    </aside>

    <main class="main">
      <header class="app-header">
        <div>
          <h1><img src={underConstruction} alt="" class="header-gif" />Stratos Demo App<img src={underConstruction} alt="" class="header-gif" /></h1>
          <p class="session-label">@{handle}</p>
        </div>
        <button class="sign-out" onclick={handleSignOut}>Log Out</button>
      </header>

      <Composer {session} {enrollment} {stratosAgent} {replyingTo} onpost={refreshFeed} oncancelreply={cancelReply} />

      <div class="feed-tabs">
        <button
          class="tab"
          class:active={activeFeed === null}
          onclick={() => handleSelectFeed(null)}
        >
          All
        </button>
        {#each enrolledDomains as domain}
          <button
            class="tab"
            class:active={activeFeed === domain}
            onclick={() => handleSelectFeed(domain)}
          >
            {displayBoundary(domain)}
          </button>
        {/each}
      </div>

      <Feed posts={filteredPosts} loading={loading} onreply={handleReply} />
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .app-header h1 {
    margin: 0;
    font-size: 1.25rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .header-gif {
    height: 1.5rem;
    width: auto;
  }

  .session-label {
    margin: 0.2rem 0 0;
    color: #666;
    font-size: 0.85rem;
    word-break: break-all;
  }

  .feed-tabs {
    display: flex;
    border-bottom: 1px solid #eee;
    padding: 0 1rem;
    gap: 0;
  }

  .tab {
    padding: 0.6rem 1rem;
    border: none;
    background: none;
    font-size: 0.88rem;
    cursor: pointer;
    color: #666;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab:hover {
    color: #333;
  }

  .tab.active {
    color: #3730a3;
    font-weight: 600;
    border-bottom-color: #3730a3;
  }
</style>

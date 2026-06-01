<script lang="ts">
  import {Agent} from '@atproto/api'
  import {onMount, setContext} from 'svelte'
  import type {OAuthSession} from '@atproto/oauth-client-browser'
  import {init, onSessionDeleted, signOut} from './lib/auth'
  import {
    APPVIEW_URL,
    checkStratosServiceStatus,
    discoverStratosEnrollment,
    fetchServerDomains,
    STRATOS_URL,
    type StratosEnrollment,
    type StratosServiceStatus,
    verifyAttestation,
  } from './lib/stratos'
  import {createServiceAgent, createStratosAgent, configureAgent} from './lib/stratos-agent'
  import {
    buildUnifiedFeed,
    type FeedPost,
    feedStats,
    fetchAppviewStratosPosts,
    fetchPublicPosts,
    fetchRepoPublicPosts,
    fetchStratosPosts,
    filterByDomain,
    resolveHandles,
  } from './lib/feed'
  import LoginScreen from './lib/LoginScreen.svelte'
  import Sidebar from './lib/Sidebar.svelte'
  import Composer from './lib/Composer.svelte'
  import Feed from './lib/Feed.svelte'
  import {displayBoundary} from './lib/boundary-display'

  let session: OAuthSession | null = $state(null)
  let enrollment: StratosEnrollment | null = $state(null)
  let stratosStatus: StratosServiceStatus | null = $state(null)
  let attestationVerified: boolean | null = $state(null)
  let appviewAgent: Agent | null = $state(null)
  let stratosAgent: Agent | null = $state(null)
  let allPosts: FeedPost[] = $state([])
  let replyingTo: FeedPost | null = $state(null)
  let loading = $state(true)
  let loadingStatus = $state('Initializing session...')
  let initialStartupDone = false
  let did = $state('')
  let handle = $state('')

  interface CustomWindow extends Window {
    __MOCK_SESSION__?: {
      sub: string
      handle?: string
      fetchHandler?: (url: string, init?: Parameters<typeof fetch>[1]) => Promise<Response>
    }
  }

  if (typeof window !== 'undefined' && (window as unknown as CustomWindow).__MOCK_SESSION__) {
    const customWindow = window as unknown as CustomWindow
    const mockSession = {
      sub: customWindow.__MOCK_SESSION__!.sub,
      fetchHandler: customWindow.__MOCK_SESSION__!.fetchHandler,
    } as unknown as OAuthSession
    session = mockSession
    did = mockSession.sub
    handle = customWindow.__MOCK_SESSION__!.handle || 'mock.bsky.social'
    // Don't set initialStartupDone = true here, let startup() run
    // initialStartupDone = true
    // loading = false
    const logDid = mockSession.sub
    const logHandle = customWindow.__MOCK_SESSION__!.handle || 'mock.bsky.social'
    console.log('Mock session detected:', {did: logDid, handle: logHandle})
  }
  let serviceUrl = $state(STRATOS_URL ?? '')
  let activeFeed: string | null = $state(null)
  let serverDomains: string[] = $state([])

  const inspectorCtx = $state({session: null as OAuthSession | null, serviceUrl: ''})
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
  let publicAgent = $derived(session ? (appviewAgent || configureAgent(new Agent(session))) : null)
  let stats = $derived(feedStats(filteredPosts))

  async function startup() {
    if (initialStartupDone) {
      return
    }
    initialStartupDone = true
    loading = true
    loadingStatus = 'Initializing session...'
    try {
      if (!session) {
        // Use a timeout for session initialization to avoid being stuck on "Loading..."
        const initPromise = init()
        const timeoutPromise = new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Auth init timeout')), 5000),
        )
        session = await (Promise.race([initPromise,
          timeoutPromise]) as Promise<OAuthSession | null>)
      }

      if (session) {
        did = session.sub
        const agent = configureAgent(new Agent(session))
        const profile = await agent.com.atproto.repo.describeRepo({repo: session.sub})
          .catch(err => {
            console.error('Failed to describe repo:', err)
            return null
          })
        if (profile) {
          handle = profile.data.handle
          await discoverAndLoad()
        } else if ((window as unknown as CustomWindow).__MOCK_SESSION__) {
          // If we have a mock session but describeRepo failed (expected in E2E), proceed anyway
          handle = (window as unknown as CustomWindow).__MOCK_SESSION__!.handle || 'mock.bsky.social'
          await discoverAndLoad()
        } else {
          session = null
        }
      }
    } catch (err) {
      console.error('Startup failed:', err)
    } finally {
      loading = false
    }
  }

  async function discoverAndLoad() {
    if (!session) {
      return
    }
    loading = true
    loadingStatus = 'Discovering service...'
    try {
      if (APPVIEW_URL) {
        appviewAgent = createServiceAgent(session, APPVIEW_URL)
      }

      enrollment = await discoverStratosEnrollment(session)

      const url = enrollment?.service ?? serviceUrl
      if (url) {
        serviceUrl = url
        stratosAgent = createStratosAgent(session, url)

        try {
          stratosStatus = await checkStratosServiceStatus(url, session.sub)
          serverDomains = await fetchServerDomains(url)
        } catch (err) {
          console.error('Failed to check service status:', err)
          stratosStatus = {enrolled: false}
        }
      } else {
        stratosStatus = {enrolled: false}
      }

      if (enrollment) {
        attestationVerified = await verifyAttestation(session.sub, enrollment)
      } else {
        attestationVerified = null
      }

      await refreshFeed()
    } finally {
      loading = false
    }
  }

  /**
   * Refreshes the feed by fetching public posts from the appview agent,
   * and optionally Stratos posts if the Stratos agent is available.
   */
  async function refreshFeed() {
    if (!session) {
      return
    }
    loading = true
    loadingStatus = 'Loading feed...'
    try {
      const publicPosts = appviewAgent
        ? await fetchPublicPosts(appviewAgent, session.sub)
        : await fetchRepoPublicPosts(configureAgent(new Agent(session)), session.sub)

      let stratosPosts: FeedPost[] = []
      if (APPVIEW_URL) {
        const res = await fetchAppviewStratosPosts(
          session,
          APPVIEW_URL,
        )
        stratosPosts = res.posts
      } else if (stratosAgent) {
        stratosPosts = await fetchStratosPosts(stratosAgent, session.sub)
      }

      const unified = buildUnifiedFeed(publicPosts, stratosPosts)
      allPosts = resolveHandles(unified, did, handle)
    } finally {
      loading = false
    }
  }

  /**
   * Handles selecting a feed domain.
   * @param domain - The domain to select. If null, all posts are selected.
   */
  function handleSelectFeed(domain: string | null) {
    activeFeed = domain
  }

  /**
   * Handles setting the service URL.
   * @param url - The new service URL.
   */
  function handleSetServiceUrl(url: string) {
    serviceUrl = url
    discoverAndLoad()
  }

  /**
   * Handles replying to a post.
   * @param post - The post to reply to.
   */
  function handleReply(post: FeedPost) {
    replyingTo = post
  }

  /**
   * Cancels replying to a post.
   */
  function cancelReply() {
    replyingTo = null
  }

  /**
   * Handles signing out the user.
   */
  async function handleSignOut() {
    if (confirm('Are you sure you want to log out?')) {
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
  }

  onMount(async () => {
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

    if (initialStartupDone && session && (window as unknown as CustomWindow).__MOCK_SESSION__) {
      await discoverAndLoad()
    } else {
      await startup()
    }
  })
</script>

{#if loading && allPosts.length === 0}
    <div class="loading-screen">
        Loading…
        <p class="loading-hint">{loadingStatus}</p>
    </div>
{:else if !session}
    <LoginScreen/>
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
                    onSetServiceUrl={handleSetServiceUrl}
            />
        </aside>

        <main class="main">
            <header class="app-header">
                <div>
                    <h1>Stratos Demo App</h1>
                    <p class="session-label">@{handle}</p>
                </div>
                <button class="sign-out" onclick={handleSignOut}>Log Out</button>
            </header>

            <Composer {session} {enrollment} {stratosAgent} {replyingTo} onpost={refreshFeed}
                      oncancelreply={cancelReply}/>

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

            <Feed posts={filteredPosts} {stratosAgent} {publicAgent} {serviceUrl} loading={loading}
                  onreply={handleReply}/>
        </main>
    </div>
{/if}

<style>
    .loading-screen {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        color: #888;
    }

    .loading-hint {
        font-size: 0.85rem;
        margin-top: 0.5rem;
        color: #aaa;
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
        color: #3730a3;
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

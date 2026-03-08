<script lang="ts">
  import { onMount } from 'svelte'
  import { Agent } from '@atproto/api'
  import type { OAuthSession } from '@atproto/oauth-client-browser'
  import { init, signOut } from './lib/auth'
  import { discoverStratosEnrollment, STRATOS_URL, type StratosEnrollment } from './lib/stratos'
  import { createStratosAgent } from './lib/stratos-agent'
  import { fetchPublicPosts, fetchStratosPosts, buildUnifiedFeed, type FeedPost } from './lib/feed'
  import { fetchProfileViaSlingshot, bannerUrl, type SlingshotProfile } from './lib/slingshot'
  import LoginScreen from './lib/LoginScreen.svelte'
  import EnrollmentIndicator from './lib/EnrollmentIndicator.svelte'
  import Composer from './lib/Composer.svelte'
  import Feed from './lib/Feed.svelte'
  import SparkleTrail from './lib/SparkleTrail.svelte'
  import MusicPlayer from './lib/MusicPlayer.svelte'
  import VisitorCounter from './lib/VisitorCounter.svelte'
  import TopFriends from './lib/TopFriends.svelte'

  let session: OAuthSession | null = $state(null)
  let enrollment: StratosEnrollment | null = $state(null)
  let stratosAgent: Agent | null = $state(null)
  let posts: FeedPost[] = $state([])
  let loading = $state(true)
  let handle = $state('')
  let serviceUrl = $state(STRATOS_URL ?? '')
  let profile: SlingshotProfile | null = $state(null)

  let bannerSrc = $derived(
    profile?.bannerCid && session ? bannerUrl(session.sub, profile.bannerCid) : null,
  )

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

    const [enrollmentResult, profileResult] = await Promise.all([
      discoverStratosEnrollment(session),
      fetchProfileViaSlingshot(session.sub),
    ])

    enrollment = enrollmentResult
    profile = profileResult

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
    profile = null
    posts = []
    handle = ''
  }

  onMount(() => {
    startup()
  })
</script>

<SparkleTrail />

{#if loading && !session}
  <div class="loading-screen">
    <div class="loading-text">~*~ lOaDiNg ~*~</div>
    <div class="loading-dots">
      <span class="dot d1">.</span><span class="dot d2">.</span><span class="dot d3">.</span>
    </div>
  </div>
{:else if !session}
  <LoginScreen />
{:else}
  <div class="page-wrapper">
    {#if bannerSrc}
      <div class="banner" style="background-image: url({bannerSrc})"></div>
    {:else}
      <div class="banner default-banner"></div>
    {/if}

    <marquee class="welcome-marquee" scrollamount="4">
      ★彡 WeLcOmE 2 mY pAgE!!1! ★彡 dOnT 4gEt 2 sIgN mY gUeStBoOk ★彡 StRaToS iS sO c00L ★彡 pRiVaCy iS pUnK rOcK 彡★
    </marquee>

    <div class="myspace-layout">
      <aside class="left-column">
        <EnrollmentIndicator {handle} did={session.sub} {enrollment} {serviceUrl} {profile} />

        <TopFriends />

        <VisitorCounter />

        <MusicPlayer />

        <button class="sign-out" onclick={handleSignOut}>
          [ x ] sIgN oUt
        </button>
      </aside>

      <main class="right-column">
        <Composer {session} {enrollment} {stratosAgent} onpost={refreshFeed} />
        <Feed {posts} loading={loading} />
      </main>
    </div>

    <footer class="footer">
      <div class="footer-hearts">♥ ♥ ♥ ♥ ♥ ♥ ♥ ♥ ♥ ♥</div>
      <div class="footer-text">~*~ MaDe WiTh ♥ bY StRaToS ~*~ © 2005 ~*~</div>
      <div class="footer-hearts">♥ ♥ ♥ ♥ ♥ ♥ ♥ ♥ ♥ ♥</div>
    </footer>
  </div>
{/if}

<style>
  .loading-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }

  .loading-text {
    color: #ff69b4;
    font-size: 1.5rem;
    font-weight: bold;
    text-shadow: 0 0 10px #ff69b4, 0 0 20px #ff00ff;
    animation: rainbow 4s linear infinite;
  }

  .loading-dots {
    font-size: 2rem;
    color: #00ffff;
  }

  .dot {
    display: inline-block;
    animation: bounce-dot 1.4s infinite;
  }
  .d2 { animation-delay: 0.15s; }
  .d3 { animation-delay: 0.3s; }

  .page-wrapper {
    min-height: 100vh;
    max-width: 900px;
    margin: 0 auto;
    border-left: 3px solid #ff00ff44;
    border-right: 3px solid #ff00ff44;
    box-shadow: 0 0 30px #ff00ff22, 0 0 60px #8b00ff11;
  }

  .banner {
    width: 100%;
    height: 140px;
    background-size: cover;
    background-position: center;
    border-bottom: 3px solid #ff00ff;
    box-shadow: 0 0 20px #ff00ff44 inset;
  }

  .default-banner {
    background: linear-gradient(135deg,
      #ff00ff, #8b00ff, #0088ff, #00ffff,
      #00ff00, #ffff00, #ff8800, #ff0000
    );
    background-size: 400% 400%;
    animation: banner-shift 8s ease infinite;
  }

  .welcome-marquee {
    display: block;
    padding: 0.4rem 0;
    background: linear-gradient(90deg, #1a003088, #0a0020, #1a003088);
    color: #ffff00;
    font-weight: bold;
    font-size: 0.8rem;
    text-shadow: 0 0 8px #ffff00;
    border-bottom: 2px solid #ffff0044;
  }

  .myspace-layout {
    display: flex;
    gap: 0;
    min-height: calc(100vh - 200px);
  }

  .left-column {
    width: 240px;
    min-width: 240px;
    border-right: 2px solid #ff00ff44;
    display: flex;
    flex-direction: column;
    gap: 0;
    background: #0a001a88;
  }

  .right-column {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 0.5rem;
  }

  .sign-out {
    margin: 0.75rem;
    padding: 0.4rem;
    background: none;
    border: 1px dashed #ff444466;
    border-radius: 4px;
    color: #ff4444;
    font-size: 0.7rem;
    font-family: inherit;
    cursor: pointer;
    text-align: center;
  }

  .sign-out:hover {
    background: #ff444422;
    border-color: #ff4444;
    text-shadow: 0 0 4px #ff4444;
  }

  .footer {
    text-align: center;
    padding: 1rem;
    border-top: 2px solid #ff69b444;
    background: #0a001a;
  }

  .footer-hearts {
    color: #ff69b4;
    font-size: 0.7rem;
    letter-spacing: 0.3em;
    animation: blink 1.5s step-end infinite;
  }

  .footer-text {
    color: #888;
    font-size: 0.65rem;
    margin: 0.3rem 0;
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

  @keyframes bounce-dot {
    0%, 80%, 100% { transform: translateY(0); }
    40% { transform: translateY(-8px); }
  }

  @keyframes banner-shift {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }

  @keyframes blink {
    50% { opacity: 0; }
  }
</style>

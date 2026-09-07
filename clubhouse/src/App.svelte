<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { fetchRoomCatalog } from './lib/catalog'
  import { loadClubhouseConfig, roomCatalogEndpoint } from './lib/config'
  import IconaMoon from './lib/components/IconaMoon.svelte'
  import Entrance from './lib/components/Entrance.svelte'
  import ErrorState from './lib/components/ErrorState.svelte'
  import HandleTypeahead from './lib/components/HandleTypeahead.svelte'
  import RoomPlaceholder from './lib/components/RoomPlaceholder.svelte'
  import {
    FeedCursorStore,
    FeedgenError,
    type ClubhouseFeedPost,
    type FeedPage,
  } from './lib/feedgen'
  import { mergeFeedAuthors } from './lib/feed-authors'
  import {
    consumeRoomJoin,
    consumeRoomReturn,
    rememberRoomJoin,
  } from './lib/join'
  import {
    roomIdFromPath,
    roomPath,
    topicPath,
    topicUriFromPath,
  } from './lib/route'
  import { DEFAULT_ROOM_VISUAL, roomVisualsFor } from './lib/room-visuals'
  import { stateForRoom } from './lib/state'
  import { captureClubhouseException, withClubhouseSpan } from './telemetry'
  import type {
    ClubhouseIntegration,
    ClubhouseIdentity,
    RoomAccessState,
    RoomCatalogEntry,
    RoomFeedState,
  } from './lib/types'

  interface Props {
    initialRooms?: readonly RoomCatalogEntry[]
    catalogEndpoint?: string
    catalogFetcher?: typeof fetchRoomCatalog
    integration?: ClubhouseIntegration
  }

  let {
    initialRooms,
    catalogEndpoint,
    catalogFetcher = fetchRoomCatalog,
    integration = {},
  }: Props = $props()

  let rooms = $state<RoomCatalogEntry[]>([])
  let states = $state<Record<string, RoomAccessState>>({})
  let loading = $state(true)
  let error = $state<string | null>(null)
  let pathname = $state('/')
  let liveMessage = $state('')
  let activeIntegration = $state<ClubhouseIntegration>({})
  let identity = $state<ClubhouseIdentity | null>(null)
  let sessionRestoring = $state(true)
  let membershipLoading = $state(true)
  let handle = $state('')
  let signingIn = $state(false)
  let signingOut = $state(false)
  let feedState = $state<RoomFeedState>('idle')
  let feedMessage = $state('')
  let posts = $state<ClubhouseFeedPost[]>([])
  let hasMore = $state(false)
  let pendingRoomId = $state<string | null>(null)
  const feedCursors = new FeedCursorStore()
  let feedRequestEpoch = 0
  let feedGeneration = 0
  let accessRequestEpoch = 0
  let disposed = false
  const deploymentConfig = loadClubhouseConfig()

  const currentRoomId = $derived(roomIdFromPath(pathname))
  const displayStates = $derived(
    sessionRestoring || membershipLoading
      ? Object.fromEntries(rooms.map((room) => [room.id, 'loading' as const]))
      : states,
  )
  const currentTopicUri = $derived(topicUriFromPath(pathname))
  const currentRoom = $derived(
    currentRoomId ? rooms.find((room) => room.id === currentRoomId) : undefined,
  )
  const currentRoomVisual = $derived(
    currentRoom
      ? (roomVisualsFor(rooms).get(currentRoom.id) ?? DEFAULT_ROOM_VISUAL)
      : DEFAULT_ROOM_VISUAL,
  )

  onMount(() => {
    pathname = window.location.pathname + window.location.search
    const onPopState = () => {
      const destination = window.location.pathname + window.location.search
      invalidateFeed(currentRoomId)
      const destinationRoomId = roomIdFromPath(destination)
      if (destinationRoomId) feedCursors.reset(destinationRoomId)
      pathname = destination
      void loadSelectedRoom()
    }
    window.addEventListener('popstate', onPopState)

    void withClubhouseSpan('clubhouse.bootstrap', initializeApp)

    return () => {
      disposed = true
      feedRequestEpoch += 1
      feedGeneration += 1
      accessRequestEpoch += 1
      window.removeEventListener('popstate', onPopState)
    }
  })

  async function initializeApp() {
    const catalogReady = loadCatalog()
    activeIntegration = integration
    try {
      if (Object.keys(activeIntegration).length === 0) {
        const { createClubhouseIntegration } = await import('./lib/integration')
        activeIntegration = createClubhouseIntegration(deploymentConfig)
      }
      const restoredIdentity = (await activeIntegration.initialize?.()) ?? null
      if (disposed) return
      identity = restoredIdentity
    } catch {
      liveMessage = 'Saved session could not be restored'
    } finally {
      sessionRestoring = false
    }
    if (disposed) return
    const roomToJoinAfterSignIn = identity ? consumeRoomJoin() : null
    const callback = new URLSearchParams(window.location.search)
    if (callback.get('stratos_enrolled') === 'true') {
      const returnPath = consumeRoomReturn()
      if (returnPath) {
        window.history.replaceState({}, '', returnPath)
        pathname = returnPath
      }
      if (callback.get('stratos_enrollment') === 'pending') {
        pendingRoomId = roomIdFromPath(returnPath ?? '')
        liveMessage = 'Room enrollment is pending reconciliation'
      } else {
        liveMessage = 'Room enrollment was updated'
      }
    }
    await catalogReady
    if (disposed) return
    if (!error) {
      await loadStates(rooms)
      void loadSelectedRoom()
    }
    if (roomToJoinAfterSignIn) {
      await joinRoom(roomToJoinAfterSignIn)
    }
  }

  async function loadCatalog() {
    loading = true
    error = null
    liveMessage = 'Loading rooms'
    try {
      const catalog = initialRooms
        ? [...initialRooms]
        : await withClubhouseSpan('clubhouse.catalogue.load', () =>
            catalogFetcher(
              globalThis.fetch,
              catalogEndpoint ??
                roomCatalogEndpoint(deploymentConfig) ??
                '/oauth/boundaries',
            ),
          )
      if (disposed) return
      rooms = catalog
      liveMessage = rooms.length
        ? `${rooms.length} rooms ready`
        : 'No rooms are open right now'
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : 'The room list could not be loaded'
      liveMessage = 'Room list unavailable'
    } finally {
      loading = false
    }
  }

  async function retryCatalog() {
    await loadCatalog()
    if (error || sessionRestoring || disposed) return
    await loadStates(rooms)
    void loadSelectedRoom()
  }

  async function loadStates(
    entries: readonly RoomCatalogEntry[],
    preservePendingRoom = true,
  ) {
    const requestEpoch = ++accessRequestEpoch
    membershipLoading = true
    try {
      if (activeIntegration.getRoomStates) {
        try {
          const resolved = await withClubhouseSpan(
            'clubhouse.room_status.load',
            () =>
              activeIntegration.getRoomStates!(entries.map((room) => room.id)),
          )
          if (requestEpoch !== accessRequestEpoch) return
          const nextStates: Record<string, RoomAccessState> = {}
          for (const room of entries) {
            const resolvedState = resolved[room.id]
            if (resolvedState) nextStates[room.id] = resolvedState
            else if (identity) nextStates[room.id] = 'status-error'
          }
          states = nextStates
        } catch {
          if (requestEpoch !== accessRequestEpoch) return
          states = Object.fromEntries(
            entries.map((room) => [room.id, 'status-error']),
          )
          liveMessage = 'Room access status is unavailable'
        }
        if (
          preservePendingRoom &&
          pendingRoomId &&
          states[pendingRoomId] === 'joined'
        ) {
          states = { ...states, [pendingRoomId]: 'pending' }
        }
        return
      }
      if (!activeIntegration.getRoomState) return
      const resolved = await Promise.all(
        entries.map(async (room) => {
          try {
            return [
              room.id,
              await activeIntegration.getRoomState?.(room.id),
            ] as const
          } catch {
            return [room.id, 'status-error'] as const
          }
        }),
      )
      if (requestEpoch !== accessRequestEpoch) return
      states = Object.fromEntries(resolved) as Record<string, RoomAccessState>
    } finally {
      if (requestEpoch === accessRequestEpoch) membershipLoading = false
    }
  }

  async function joinRoom(roomId: string) {
    if (sessionRestoring || membershipLoading) return
    if (!identity) {
      rememberRoomJoin(roomId)
      liveMessage = 'Sign in with your ATProto handle to join this room.'
      document.getElementById('handle')?.focus()
      return
    }
    states[roomId] = 'pending'
    liveMessage = `Joining ${rooms.find((room) => room.id === roomId)?.displayName ?? 'room'}`
    if (!activeIntegration.requestJoin) return

    try {
      const result = await withClubhouseSpan('clubhouse.room.join', () =>
        activeIntegration.requestJoin!(roomId),
      )
      if (result) states[roomId] = result
      liveMessage =
        result === 'joined' ? 'You joined the room' : 'Join request pending'
    } catch {
      states[roomId] = 'unjoined'
      liveMessage = 'Join request could not be started'
    }
  }

  function openRoom(roomId: string) {
    invalidateFeed(currentRoomId)
    feedCursors.reset(roomId)
    const destination = roomPath(roomId)
    window.history.pushState({}, '', destination)
    pathname = destination
    void loadSelectedRoom()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function goHome() {
    invalidateFeed(currentRoomId)
    window.history.pushState({}, '', '/')
    pathname = '/'
  }

  function openTopic(topicUri: string) {
    if (!currentRoomId) return
    const destination = topicPath(currentRoomId, topicUri)
    window.history.pushState({}, '', destination)
    pathname = destination
  }

  function closeTopic() {
    if (!currentRoomId) return
    const destination = roomPath(currentRoomId)
    window.history.pushState({}, '', destination)
    pathname = destination
  }

  async function signIn() {
    if (!handle.trim() || !activeIntegration.signIn) return
    signingIn = true
    liveMessage = 'Opening secure sign-in'
    try {
      await activeIntegration.signIn(handle.trim())
    } catch (cause) {
      liveMessage =
        cause instanceof Error ? cause.message : 'Sign-in could not be started'
    } finally {
      signingIn = false
    }
  }

  async function signOut() {
    if (!activeIntegration.signOut) return
    signingOut = true
    liveMessage = 'Signing out'
    try {
      await activeIntegration.signOut()
      accessRequestEpoch += 1
      membershipLoading = false
      identity = null
      states = {}
      pendingRoomId = null
      invalidateFeed(currentRoomId)
      liveMessage = 'Signed out'
    } catch (cause) {
      liveMessage = cause instanceof Error ? cause.message : 'Sign-out failed'
    } finally {
      signingOut = false
    }
  }

  async function loadSelectedRoom(loadMore = false) {
    const requestEpoch = ++feedRequestEpoch
    const room = currentRoom
    if (
      sessionRestoring ||
      membershipLoading ||
      !room ||
      stateForRoom(room, states) !== 'joined'
    )
      return
    if (!activeIntegration.getFeed) {
      feedState = 'NetworkError'
      feedMessage =
        'Feed access is not configured for this Clubhouse deployment.'
      return
    }
    if (!loadMore) {
      feedGeneration += 1
      feedCursors.reset(room.id)
      posts = []
    }
    feedState = 'loading'
    feedMessage = ''
    const generation = feedGeneration
    const viewerDid = identity?.did
    const feedIntegration = activeIntegration
    try {
      const page = await withClubhouseSpan(
        loadMore ? 'clubhouse.feed.paginate' : 'clubhouse.feed.load',
        () =>
          activeIntegration.getFeed!(
            room.id,
            50,
            loadMore ? feedCursors.get(room.id) : undefined,
          ),
      )
      if (requestEpoch !== feedRequestEpoch || currentRoomId !== room.id) return
      posts = loadMore ? [...posts, ...page.posts] : page.posts
      feedCursors.set(room.id, page.cursor)
      hasMore = Boolean(page.cursor)
      feedState = posts.length ? 'ready' : 'empty'
      liveMessage = posts.length
        ? `${posts.length} room posts loaded`
        : 'No room posts yet'
      void enrichRenderedAuthors(
        page,
        room.id,
        generation,
        viewerDid,
        feedIntegration,
      )
    } catch (cause) {
      if (requestEpoch !== feedRequestEpoch || currentRoomId !== room.id) return
      captureClubhouseException(cause)
      const code = cause instanceof FeedgenError ? cause.code : 'NetworkError'
      feedState = code === 'InvalidResponse' ? 'NetworkError' : code
      feedMessage =
        cause instanceof Error ? cause.message : 'The room could not be loaded'
      liveMessage = feedMessage
    }
  }

  async function enrichRenderedAuthors(
    page: FeedPage,
    roomId: string,
    generation: number,
    viewerDid: string | undefined,
    feedIntegration: ClubhouseIntegration,
  ) {
    if (!feedIntegration.enrichFeedAuthors) return
    await tick()
    try {
      const enriched = await feedIntegration.enrichFeedAuthors(page)
      if (
        generation !== feedGeneration ||
        currentRoomId !== roomId ||
        identity?.did !== viewerDid
      )
        return
      posts = mergeFeedAuthors(posts, enriched.posts)
    } catch (cause) {
      captureClubhouseException(cause)
    }
  }

  function invalidateFeed(roomId: string | null) {
    feedRequestEpoch += 1
    feedGeneration += 1
    if (roomId) feedCursors.reset(roomId)
    posts = []
    hasMore = false
    feedState = 'idle'
    feedMessage = ''
  }

  async function recheckPendingRoom() {
    if (!currentRoom) return
    await loadStates(rooms, false)
    if (stateForRoom(currentRoom, states) !== 'joined') {
      liveMessage = 'The room is still reconciling. Try again shortly.'
      return
    }
    pendingRoomId = null
    await loadSelectedRoom()
  }

  async function postToRoom(
    text: string,
    reply?: import('./lib/post-writer').ReplyRef,
  ) {
    if (!currentRoom || !activeIntegration.createPost) {
      feedMessage = 'Posting needs service configuration for this room.'
      return
    }
    try {
      await withClubhouseSpan('clubhouse.post.create', () =>
        activeIntegration.createPost!(currentRoom.id, text, reply),
      )
      liveMessage = 'Post sent to the room'
      await loadSelectedRoom()
    } catch (cause) {
      feedMessage =
        cause instanceof Error ? cause.message : 'Post could not be created'
      liveMessage = feedMessage
      throw cause
    }
  }

  async function deletePostFromRoom(post: ClubhouseFeedPost) {
    const room = currentRoom
    if (!room || !activeIntegration.deletePost) {
      throw new Error('Deleting needs service configuration for this room.')
    }
    try {
      await withClubhouseSpan('clubhouse.post.delete', () =>
        activeIntegration.deletePost!(room.id, post),
      )
      liveMessage = 'Post deleted from the room'
      if (currentRoomId !== room.id) return
      if (currentTopicUri === post.uri) closeTopic()
      await loadSelectedRoom()
    } catch (cause) {
      feedMessage =
        cause instanceof Error ? cause.message : 'Post could not be deleted'
      liveMessage = feedMessage
      throw cause
    }
  }
</script>

<svelte:head>
  <meta
    name="description"
    content="Clubhouse: open rooms to explore and join."
  />
</svelte:head>

<div class="app-shell">
  <header class="site-header">
    <a
      class="brand"
      href="/"
      aria-label="Clubhouse home"
      onclick={(event) => {
        event.preventDefault()
        goHome()
      }}
    >
      <span class="brand-mark" aria-hidden="true"
        ><IconaMoon name="home" /></span
      >
      <span class="brand-copy"
        ><strong>clubhouse</strong><small>private rooms on ATProto</small></span
      >
    </a>
    {#if identity}
      <div class="signed-in-account">
        <p class="header-note" title={identity.did}>
          Signed in as {identity.handle ?? identity.did}
        </p>
        <button
          class="button button-secondary"
          type="button"
          disabled={signingOut}
          onclick={() => void signOut()}
          >{signingOut ? 'Signing out…' : 'Sign out'}</button
        >
      </div>
    {:else if sessionRestoring}
      <p class="header-note" role="status">Restoring your session…</p>
    {:else}
      <form
        class="sign-in"
        onsubmit={(event) => {
          event.preventDefault()
          void signIn()
        }}
      >
        <label for="handle">ATProto handle</label>
        <HandleTypeahead bind:value={handle} disabled={signingIn} />
        <button
          class="button button-secondary"
          type="submit"
          disabled={signingIn || !handle.trim()}
          >{signingIn ? 'Opening…' : 'Sign in'}</button
        >
      </form>
    {/if}
  </header>

  <main>
    <div class="live-region" aria-live="polite" aria-atomic="true">
      {liveMessage}
    </div>
    {#if loading}
      <section
        class="loading-state"
        aria-busy="true"
        aria-labelledby="loading-title"
      >
        <span class="loading-icon" aria-hidden="true"
          ><IconaMoon name="clock" /></span
        >
        <h1 id="loading-title">Mapping the rooms…</h1>
        <p>One moment while the clubhouse gets ready.</p>
      </section>
    {:else if error}
      <ErrorState message={error} onRetry={retryCatalog} />
    {:else if currentRoomId && currentRoom}
      <RoomPlaceholder
        room={currentRoom}
        state={stateForRoom(currentRoom, displayStates)}
        visual={currentRoomVisual}
        onBack={goHome}
        onJoin={joinRoom}
        onRecheckPending={() => void recheckPendingRoom()}
        {feedState}
        {posts}
        {hasMore}
        {feedMessage}
        topicUri={currentTopicUri}
        viewerDid={identity?.did ?? null}
        onOpenTopic={openTopic}
        onCloseTopic={closeTopic}
        onLoadMore={() => void loadSelectedRoom(true)}
        onPost={postToRoom}
        onDelete={deletePostFromRoom}
      />
    {:else if currentRoomId}
      <ErrorState
        message="That room does not appear in the current catalogue."
        onRetry={goHome}
      />
    {:else}
      <Entrance
        {rooms}
        states={displayStates}
        onJoin={joinRoom}
        onOpen={openRoom}
      />
    {/if}
  </main>

  <footer class="site-footer">
    <p><strong>Clubhouse</strong> · A Stratos alpha demonstration.</p>
    <p>Supports both Spaces and non-spaces users.</p>
  </footer>
</div>

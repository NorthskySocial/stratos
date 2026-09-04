<script lang="ts">
  import type { RoomAccessState, RoomCatalogEntry } from '../types'
  import type { RoomVisual } from '../room-visuals'
  import type { ClubhouseFeedPost } from '../feedgen'
  import type { RoomFeedState } from '../types'
  import IconaMoon from './IconaMoon.svelte'
  import RoomFeed from './RoomFeed.svelte'

  interface Props {
    room: RoomCatalogEntry
    state: RoomAccessState
    visual: RoomVisual
    onBack: () => void
    onJoin: (roomId: string) => void
    onRecheckPending: () => void
    feedState: RoomFeedState
    posts: readonly ClubhouseFeedPost[]
    hasMore: boolean
    feedMessage: string
    onLoadMore: () => void
    topicUri: string | null
    onOpenTopic: (uri: string) => void
    onCloseTopic: () => void
    onPost: (text: string, reply?: import('../post-writer').ReplyRef) => Promise<void>
  }

  let { room, state, visual, onBack, onJoin, onRecheckPending, feedState, posts, hasMore, feedMessage, topicUri, onOpenTopic, onCloseTopic, onLoadMore, onPost }: Props = $props()
</script>

<section class="room-view" aria-labelledby="room-title">
  <button class="back-link" type="button" onclick={onBack}>Back to rooms</button>
  <div class="room-view-heading">
    <span class={`room-icon room-view-icon room-icon-${visual.tone}`} aria-hidden="true"><IconaMoon name={visual.icon} /></span>
    <div>
      <h1 id="room-title">{room.displayName}</h1>
      <p>{room.description}</p>
    </div>
  </div>

  {#if state === 'joined'}
    <RoomFeed {feedState} {posts} {hasMore} message={feedMessage} {topicUri} {onOpenTopic} {onCloseTopic} {onLoadMore} {onPost} />
  {:else if state === 'pending'}
    <div class="placeholder-panel">
      <div class="panel-icon"><IconaMoon name="information" /></div>
      <div>
        <h2>Your join request is pending.</h2>
        <p>Enrollment is finishing in the background. You can return here when the room is ready.</p>
        <button class="button button-secondary" type="button" onclick={onRecheckPending}>
          Check room again
        </button>
      </div>
    </div>
  {:else if state === 'unavailable'}
    <div class="placeholder-panel">
      <div class="panel-icon"><IconaMoon name="information" /></div>
      <div>
        <h2>This room is not accepting new members.</h2>
        <p>Its posts remain available only to people who already joined. Return to the room list to explore another open membership area.</p>
      </div>
    </div>
  {:else if state === 'status-error'}
    <div class="placeholder-panel">
      <div class="panel-icon"><IconaMoon name="information" /></div>
      <div>
        <h2>Room access status is unavailable.</h2>
        <p>We could not verify whether you are already a member. You can still start the room’s secure enrollment flow.</p>
        <button class="button button-primary" type="button" onclick={() => onJoin(room.id)}>Join room</button>
      </div>
    </div>
  {:else}
    <div class="placeholder-panel">
      <div class="panel-icon"><IconaMoon name="information" /></div>
      <div>
        <h2>Join this room to continue.</h2>
        <p>This is an open membership area. Joining starts the room’s enrollment flow; the interface state is only a guide, not access control.</p>
        <button class="button button-primary" type="button" onclick={() => onJoin(room.id)}>Join room</button>
      </div>
    </div>
  {/if}
</section>

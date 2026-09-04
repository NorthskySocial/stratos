<script lang="ts">
  import { roomPath } from '../route'
  import type { RoomVisual } from '../room-visuals'
  import type { RoomAccessState, RoomCatalogEntry } from '../types'
  import IconaMoon from './IconaMoon.svelte'

  interface Props {
    room: RoomCatalogEntry
    state: RoomAccessState
    visual: RoomVisual
    onJoin: (roomId: string) => void
    onOpen: (roomId: string) => void
  }

  let { room, state, visual, onJoin, onOpen }: Props = $props()
  const stateLabel: Record<RoomAccessState, string> = {
    joined: 'Joined',
    unjoined: 'Open to join',
    unavailable: 'Not accepting joins',
    pending: 'Request pending',
    'status-error': 'Access status unavailable · you can still join',
  }

  function openRoom(event: MouseEvent) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }
    event.preventDefault()
    onOpen(room.id)
  }
</script>

<article class="room-card" class:room-unjoined={state === 'unjoined' || state === 'status-error'} class:room-unavailable={state === 'unavailable'}>
  <div class="room-card-topline">
    <span class={`room-icon room-icon-${visual.tone}`} aria-hidden="true"><IconaMoon name={visual.icon} /></span>
    <span class:status-joined={state === 'joined'} class:status-pending={state === 'pending'} class:status-unavailable={state === 'unavailable'} class="status">
      {#if state === 'joined'}<IconaMoon name="check" />{/if}
      {stateLabel[state]}
    </span>
  </div>

  <div class="room-card-content">
    <h3>{room.displayName}</h3>
    <p>{room.description}</p>
  </div>

  <div class="room-card-actions">
    {#if state === 'joined'}
      <button class="button button-primary" type="button" onclick={() => onOpen(room.id)}>Open room</button>
    {:else}
      <button
        class="button button-primary"
        type="button"
        disabled={state === 'unavailable' || state === 'pending'}
        onclick={() => onJoin(room.id)}
      >
        {state === 'pending' ? 'Request pending…' : state === 'unavailable' ? 'Joining unavailable' : 'Join room'}
      </button>
    {/if}
    <a class="room-link" href={roomPath(room.id)} onclick={openRoom}>About this room</a>
  </div>
</article>

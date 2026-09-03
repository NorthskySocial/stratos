<script lang="ts">
  import { roomPath } from '../route'
  import type { RoomAccessState, RoomCatalogEntry } from '../types'
  import IconaMoon from './IconaMoon.svelte'

  interface Props {
    room: RoomCatalogEntry
    state: RoomAccessState
    onJoin: (roomId: string) => void
    onOpen: (roomId: string) => void
  }

  let { room, state, onJoin, onOpen }: Props = $props()
  const stateLabel: Record<RoomAccessState, string> = {
    joined: 'Joined',
    unjoined: 'Open to join',
    unavailable: 'Not accepting joins',
    pending: 'Request pending',
    'status-error': 'Access status unavailable',
  }
</script>

<article class="room-card" class:room-unjoined={state === 'unjoined'} class:room-unavailable={state === 'unavailable' || state === 'status-error'}>
  <div class="room-card-topline">
    <span class="room-orbit" aria-hidden="true"><span></span></span>
    <span class:status-joined={state === 'joined'} class:status-pending={state === 'pending'} class:status-unavailable={state === 'unavailable' || state === 'status-error'} class="status">
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
        disabled={state === 'unavailable' || state === 'pending' || state === 'status-error'}
        onclick={() => onJoin(room.id)}
      >
        {state === 'pending' ? 'Request pending…' : state === 'unavailable' || state === 'status-error' ? 'Joining unavailable' : 'Join room'}
      </button>
    {/if}
    <a class="room-link" href={roomPath(room.id)} onclick={(event) => { event.preventDefault(); onOpen(room.id) }}>About this room</a>
  </div>
</article>

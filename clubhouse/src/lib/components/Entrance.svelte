<script lang="ts">
  import type { RoomAccessState, RoomCatalogEntry } from '../types'
  import { DEFAULT_ROOM_VISUAL, roomVisualsFor } from '../room-visuals'
  import { stateForRoom } from '../state'
  import IconaMoon from './IconaMoon.svelte'
  import Room from './Room.svelte'

  interface Props {
    rooms: readonly RoomCatalogEntry[]
    states: Readonly<Record<string, RoomAccessState>>
    onJoin: (roomId: string) => void
    onOpen: (roomId: string) => void
  }

  let { rooms, states, onJoin, onOpen }: Props = $props()
  const roomVisuals = $derived(roomVisualsFor(rooms))
</script>

<section class="entrance" aria-labelledby="entrance-title">
  <div class="entrance-copy">
    <div class="entrance-title-lockup">
      <h1 id="entrance-title">Find your room in the clubhouse.</h1>
      <span class="edition-stamp" aria-hidden="true">Open rooms<br />live now</span>
    </div>
    <p class="entrance-lede">Join a room to hang out and chat.</p>
  </div>

  {#if rooms.length > 0}
    <ul class="room-grid" aria-label="Available rooms">
      {#each rooms as room (room.id)}
        <li><Room room={room} state={stateForRoom(room, states)} visual={roomVisuals.get(room.id) ?? DEFAULT_ROOM_VISUAL} {onJoin} {onOpen} /></li>
      {/each}
    </ul>
  {:else}
    <div class="empty-state">
      <span class="empty-icon" aria-hidden="true"><IconaMoon name="gift" /></span>
      <h2>No rooms are open right now</h2>
      <p>Check back soon for a new room to explore.</p>
    </div>
  {/if}
</section>

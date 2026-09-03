<script lang="ts">
  import type { RoomAccessState, RoomCatalogEntry } from '../types'
  import { stateForRoom } from '../state'
  import Room from './Room.svelte'

  interface Props {
    rooms: readonly RoomCatalogEntry[]
    states: Readonly<Record<string, RoomAccessState>>
    onJoin: (roomId: string) => void
    onOpen: (roomId: string) => void
  }

  let { rooms, states, onJoin, onOpen }: Props = $props()

</script>

<section class="entrance" aria-labelledby="entrance-title">
  <div class="entrance-copy">
    <h1 id="entrance-title">Find your room in the constellation.</h1>
    <p class="entrance-lede">A clubhouse for small, open membership areas. Choose a room to open its details, then join when you are ready.</p>
  </div>

  {#if rooms.length > 0}
    <ul class="room-grid" aria-label="Available rooms">
      {#each rooms as room (room.id)}
        <li><Room room={room} state={stateForRoom(room, states)} {onJoin} {onOpen} /></li>
      {/each}
    </ul>
  {:else}
    <div class="empty-state">
      <span class="empty-ring" aria-hidden="true"></span>
      <h2>No rooms are open right now</h2>
      <p>Check back soon for a new room to explore.</p>
    </div>
  {/if}
</section>

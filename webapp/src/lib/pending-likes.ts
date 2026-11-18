import { getContext, setContext } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'

/** What the member did to a post's like since the feed last said what they had. */
export interface PendingLike {
  likeUri: string | undefined
  likeCount: number
}

const PENDING_LIKES = Symbol('pending-likes')

/**
 * Pending like state by post URI. The feed generator ingests a write a moment
 * later, and a refresh rebuilds the post cards, so the state lives above them.
 */
export class PendingLikes {
  readonly #byPostUri = new SvelteMap<string, PendingLike>()

  get(postUri: string): PendingLike | undefined {
    return this.#byPostUri.get(postUri)
  }

  record(postUri: string, pending: PendingLike): void {
    this.#byPostUri.set(postUri, pending)
  }

  clear(postUri: string): void {
    this.#byPostUri.delete(postUri)
  }
}

/** Gives the like buttons below the calling component one shared store. */
export function providePendingLikes(): PendingLikes {
  return setContext(PENDING_LIKES, new PendingLikes())
}

/** The store of the nearest feed, or a store of its own for a button outside one. */
export function usePendingLikes(): PendingLikes {
  return (
    getContext<PendingLikes | undefined>(PENDING_LIKES) ?? new PendingLikes()
  )
}

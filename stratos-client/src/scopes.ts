import type { StratosScopes } from './types.js'

/**
 * default OAuth scope identifiers for Stratos record collections.
 * these correspond to atproto granular scopes for specific collections.
 */
export const STRATOS_SCOPES: StratosScopes = {
  enrollment: 'app.stratos.actor.enrollment',
  post: 'app.stratos.feed.post',
}

/**
 * builds the full atproto scope string for a collection.
 * format: `repo:collection:create,update,delete`
 *
 * @param collection the collection NSID
 * @param abilities the abilities to request (defaults to all write abilities)
 * @returns the formatted scope string
 */
export const buildCollectionScope = (
  collection: string,
  abilities: string[] = ['create', 'update', 'delete'],
): string => {
  return `repo:${collection}:${abilities.join(',')}`
}

/**
 * builds the standard set of OAuth scopes needed for Stratos operations.
 * includes transition:generic and transition:chat.bsky for compatibility,
 * plus granular scopes for enrollment and post collections.
 *
 * @returns array of scope strings
 */
export const buildStratosScopes = (): string[] => {
  return [
    'transition:generic',
    'transition:chat.bsky',
    buildCollectionScope(STRATOS_SCOPES.enrollment),
    buildCollectionScope(STRATOS_SCOPES.post),
  ]
}

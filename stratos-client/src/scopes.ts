import type { StratosScopes } from './types.js'

const ALL_ACTIONS = ['create', 'update', 'delete']

/**
 * default OAuth scope identifiers for Stratos record collections.
 * these correspond to atproto granular scopes for specific collections.
 */
export const STRATOS_SCOPES: StratosScopes = {
  enrollment: 'app.northsky.stratos.actor.enrollment',
  post: 'app.northsky.stratos.feed.post',
}

/**
 * builds an atproto `repo:` scope string for a collection.
 * follows the ATProto permissions spec: omits action params when all
 * actions are requested (create, update, delete), uses query params otherwise.
 *
 * @param collection the collection NSID
 * @param actions the actions to request (defaults to all write actions)
 * @returns the formatted scope string
 */
export const buildCollectionScope = (
  collection: string,
  actions: string[] = ALL_ACTIONS,
): string => {
  const isAllActions =
    actions.length === ALL_ACTIONS.length &&
    ALL_ACTIONS.every((a) => actions.includes(a))

  if (isAllActions) {
    return `repo:${collection}`
  }

  const params = actions.map((a) => `action=${a}`).join('&')
  return `repo:${collection}?${params}`
}

/**
 * builds the standard set of OAuth scopes needed for Stratos operations.
 * includes the `atproto` base scope plus granular repo scopes for
 * enrollment and post collections.
 *
 * @returns array of scope strings
 */
export const buildStratosScopes = (): string[] => {
  return [
    'atproto',
    buildCollectionScope(STRATOS_SCOPES.enrollment),
    buildCollectionScope(STRATOS_SCOPES.post),
  ]
}

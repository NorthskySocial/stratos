import type { StratosScopes } from './types.js'
import { ENROLLMENT_COLLECTION } from './discovery.js'

const ALL_ACTIONS = ['create', 'update', 'delete']

/**
 * default OAuth scope identifiers for Stratos record collections.
 * these correspond to atproto granular scopes for specific collections.
 */
export const STRATOS_SCOPES: StratosScopes = {
  enrollment: ENROLLMENT_COLLECTION,
  post: 'zone.stratos.feed.post',
  getFeed: 'zone.stratos.feedgen.getFeed',
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
 * builds an atproto `rpc:` scope string for an XRPC method.
 * follows the ATProto permissions spec. The `aud` (audience) defaults to
 * `*`, granting the method against any service so the scope is not pinned
 * to a single service DID.
 *
 * @param lxm the XRPC method NSID
 * @param aud the audience; defaults to `*` (any service)
 * @returns the formatted scope string
 */
export const buildRpcScope = (lxm: string, aud = '*'): string => {
  return `rpc:${lxm}?aud=${aud}`
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
    buildCollectionScope(STRATOS_SCOPES.post, ['create', 'delete']),
    buildRpcScope(STRATOS_SCOPES.getFeed),
  ]
}

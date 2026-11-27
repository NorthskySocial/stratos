import type { LabelStore } from '@northskysocial/stratos-core'
import type { AppContext } from '../context.js'

/** The label-log read that decides whether an account is taken down. */
export type AccountTakedownLog = Pick<LabelStore, 'latestTakedowns'>

/**
 * Whether the author's account is taken down: the latest label on the account
 * is a takedown. Account subject keys are the bare DID. One label-log query.
 * Nothing is cached, so a takedown or its negation reaches the next read on
 * every service instance. An operator hold is not read here and hides
 * nothing.
 */
export async function isAccountTakenDown(
  log: AccountTakedownLog,
  authorDid: string,
): Promise<boolean> {
  return (await log.latestTakedowns([authorDid])).has(authorDid)
}

/**
 * Select which of `candidateUris` a sync consumer must not receive a value
 * for: every one when the author's account is taken down, else those whose
 * record is. Costs one actor-store read and one label-log read. Any read
 * error propagates, so a caller never sends an unfiltered event.
 */
export async function resolveHiddenUris(
  ctx: AppContext,
  did: string,
  candidateUris: ReadonlySet<string>,
): Promise<Set<string>> {
  if (candidateUris.size === 0) return new Set()
  const states = await ctx.actorStore.read(did, (store) =>
    store.record.getTakedownStates([...candidateUris]),
  )
  const hidden = new Set<string>()
  for (const [uri, takenDown] of states) {
    if (takenDown) hidden.add(uri)
  }

  // A deleted record has no marker left, so the label log is the only record of
  // its takedown. A row without a marker is a re-created record, which is served.
  // The author's account shares the read, as in isAccountTakenDown; a DID key
  // never equals a record URI.
  const rowless = [...candidateUris].filter((uri) => !states.has(uri))
  const takenDown = await ctx.labelStore.latestTakedowns([did, ...rowless])
  if (takenDown.has(did)) return new Set(candidateUris)
  for (const uri of rowless) {
    if (takenDown.has(uri)) hidden.add(uri)
  }
  return hidden
}

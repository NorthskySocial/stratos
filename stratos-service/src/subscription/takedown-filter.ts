import type { AppContext } from '../context.js'

/**
 * Select which of `candidateUris` a sync consumer must not receive a value
 * for. Costs one actor-store read, plus one label-log read only when some
 * candidate has no record row. Any read error propagates, so a caller never
 * sends an unfiltered event.
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
  const rowless = [...candidateUris].filter((uri) => !states.has(uri))
  if (rowless.length === 0) return hidden
  for (const uri of await ctx.labelStore.latestTakedowns(rowless)) {
    hidden.add(uri)
  }
  return hidden
}

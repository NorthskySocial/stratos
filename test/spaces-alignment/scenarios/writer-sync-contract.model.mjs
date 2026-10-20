export async function catchUp(list, durableProcess, checkpoint) {
  let cursor = checkpoint
  for (;;) {
    const page = await list(cursor)
    if (page.repos.length === 0) return cursor
    await durableProcess(page.repos)
    cursor = page.cursor
  }
}

export function acceptWrite(state, input, members, now, nextRevision) {
  if (!members.has(input.repo)) throw new Error('Unauthorized writer')
  if (input.timestamp > now + 300_000) throw new Error('FutureRev')
  const previous = state.writers.get(input.repo)
  if (previous && input.repoRev <= previous.repoRev) return undefined
  const sequence = { spaceRev: nextRevision(state.spaceRev) }
  sequence.prevSpaceRev = state.spaceRev
  state.writers.set(input.repo, { ...input, spaceRev: sequence.spaceRev })
  state.spaceRev = sequence.spaceRev
  return sequence
}

export function coalesceRetry(pending, update) {
  return !pending || update.repoRev > pending.repoRev ? update : pending
}

export function clearDelivered(pending, delivered) {
  return pending.repoRev <= delivered.repoRev ? undefined : pending
}

export function retryDelay(attempt, jitter) {
  return Math.floor(
    Math.min(60_000 * 2 ** Math.min(attempt - 1, 6), 3_600_000) * jitter,
  )
}

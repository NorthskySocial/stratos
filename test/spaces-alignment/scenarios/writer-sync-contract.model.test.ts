import { describe, expect, it } from 'vitest'
import {
  catchUp,
  acceptWrite,
  coalesceRetry,
  clearDelivered,
  retryDelay,
} from './writer-sync-contract.model.mjs'

describe('synthetic writer-sync reference model, not an authority implementation', () => {
  it('continues short pages until EMPTY, permits repeated writers and preserves opaque checkpoint', async () => {
    const members = new Set(['did:plc:faye', 'did:plc:edward'])
    const requests: unknown[] = []
    const durable: unknown[] = []
    const pages = [
      { repos: [{ did: 'did:plc:faye', repoRev: 'a' }], cursor: 'not-a-tid' },
      { repos: [{ did: 'did:plc:faye', repoRev: 'b' }], cursor: 'z' },
      { repos: [] },
    ]
    expect(
      await catchUp(
        async (cursor) => {
          requests.push(cursor)
          return pages.shift()!
        },
        async (rows) => {
          durable.push(rows)
        },
        'arbitrary/start',
      ),
    ).toBe('z')
    expect(requests).toEqual(['arbitrary/start', 'not-a-tid', 'z'])
    expect(durable).toEqual([
      [{ did: 'did:plc:faye', repoRev: 'a' }],
      [{ did: 'did:plc:faye', repoRev: 'b' }],
    ])
    expect([...members]).toEqual(['did:plc:faye', 'did:plc:edward'])
    expect(
      await catchUp(
        async () => ({ repos: [] }),
        async () => {
          throw new Error('empty page processed')
        },
        'saved',
      ),
    ).toBe('saved')
  })
  it('does not advance before durable processing and replays idempotently after a crash', async () => {
    const rows = [{ did: 'did:plc:faye', repoRev: 'a' }]
    const stored = new Map()
    let checkpoint: string | undefined = 'old'
    const list = async (cursor?: string) =>
      cursor === 'old' ? { repos: rows, cursor: 'new' } : { repos: [] }
    await expect(
      catchUp(
        list,
        async (items) => {
          for (const row of items) stored.set(row.did, row.repoRev)
          throw new Error('crash')
        },
        checkpoint,
      ),
    ).rejects.toThrow('crash')
    expect(checkpoint).toBe('old')
    checkpoint = await catchUp(
      list,
      async (items) => {
        for (const row of items) stored.set(row.did, row.repoRev)
      },
      checkpoint,
    )
    expect(checkpoint).toBe('new')
    expect([...stored]).toEqual([['did:plc:faye', 'a']])
  })
  it('admits only current members, ignores old/equal heads and sequences across writers', () => {
    const state = { writers: new Map(), spaceRev: undefined }
    const members = new Set(['faye', 'edward'])
    const next = (previous?: string) =>
      previous === undefined ? 's1' : previous === 's1' ? 's2' : 's3'
    const write = (repo: string, repoRev: string, timestamp = 300_000) => ({
      repo,
      repoRev,
      timestamp,
      hash: repoRev,
    })
    expect(() =>
      acceptWrite(state, write('jet', 'a'), members, 0, next),
    ).toThrow('Unauthorized writer')
    expect(() =>
      acceptWrite(state, write('faye', 'a', 300_001), members, 0, next),
    ).toThrow('FutureRev')
    expect(state.writers.size).toBe(0)
    expect(acceptWrite(state, write('faye', 'b'), members, 0, next)).toEqual({
      spaceRev: 's1',
    })
    for (const rev of ['a', 'b'])
      expect(
        acceptWrite(state, write('faye', rev), members, 0, next),
      ).toBeUndefined()
    expect(state.writers.get('faye')).toEqual({
      ...write('faye', 'b'),
      spaceRev: 's1',
    })
    expect(acceptWrite(state, write('edward', 'a'), members, 0, next)).toEqual({
      spaceRev: 's2',
      prevSpaceRev: 's1',
    })
    expect(acceptWrite(state, write('faye', 'c'), members, 0, next)).toEqual({
      spaceRev: 's3',
      prevSpaceRev: 's2',
    })
    expect(state.spaceRev).toBe('s3')
    expect(state.writers.get('faye').repoRev).toBe('c')
    members.delete('faye')
    expect(() =>
      acceptWrite(state, write('faye', 'd'), members, 0, next),
    ).toThrow('Unauthorized writer')
    expect(state.spaceRev).toBe('s3')
  })
  it('coalesces newest state and does not let old completion erase newer retries', () => {
    const older = { repoRev: 'a', hash: 'old' }
    const current = { repoRev: 'b', hash: 'new' }
    expect(coalesceRetry(undefined, older)).toBe(older)
    expect(coalesceRetry(older, current)).toBe(current)
    expect(coalesceRetry(current, older)).toBe(current)
    expect(coalesceRetry(current, { repoRev: 'b', hash: 'different' })).toBe(
      current,
    )
    expect(clearDelivered(current, older)).toBe(current)
    expect(clearDelivered(current, current)).toBeUndefined()
    expect(clearDelivered(older, current)).toBeUndefined()
    expect(retryDelay(1, 0.5)).toBe(30_000)
    expect(retryDelay(2, 1)).toBe(120_000)
    expect(retryDelay(7, 1)).toBe(3_600_000)
    expect(retryDelay(1000, 0.5)).toBe(1_800_000)
    expect(retryDelay(1, 0.50001)).toBe(30_000)
  })
})

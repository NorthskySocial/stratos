import { describe, expect, it, vi } from 'vitest'
import {
  advanceKnownWriter,
  confirmPdsHead,
  planStandardWriters,
  type AuthorityMember,
  type VerifiedPdsHead,
} from './authority-contract.adapter.js'

const authority = 'did:web:motoko.test'
const space = `at://${authority}/space/zone.stratos.space.feed/general`
const rev = '3lqj7l6h6x222'
const motoko = 'did:plc:motokokusangai00000000'
const asuka = 'did:plc:asukalangley0000000000'

async function head(did = motoko, value = 7) {
  return confirmPdsHead(
    { did, rev, hash: new Uint8Array(32).fill(value) },
    async () => {},
  )
}

const members: AuthorityMember[] = [
  { did: motoko, custody: 'pds', active: true, boundaries: ['general'] },
  { did: asuka, custody: 'stratos', active: true, boundaries: ['general'] },
]

describe('sandbox standard writer fixture', () => {
  it('requires a validated PDS head before admitting a row', async () => {
    const verify = vi.fn().mockResolvedValue(undefined)
    const signed = { did: motoko, rev, hash: new Uint8Array(32).fill(7) }
    const confirmed = await confirmPdsHead(signed, verify)
    expect(verify).toHaveBeenCalledOnce()
    expect(verify).toHaveBeenCalledWith({
      did: motoko,
      rev,
      hash: new Uint8Array(32).fill(7),
    })
    signed.hash.fill(0)
    expect(confirmed.hash[0]).toBe(7)
    confirmed.hash.fill(0)
    expect(confirmed.hash[0]).toBe(7)
    const admitted = planStandardWriters(
      [members[0]],
      'general',
      new Map([[motoko, confirmed]]),
    )
    expect(admitted.rows[0].hash).toEqual(new Uint8Array(32).fill(7))
    expect(admitted.publishable).toBe(true)
    await expect(
      confirmPdsHead(signed, async () => {
        throw Error('bad signature')
      }),
    ).rejects.toThrow('bad signature')
    await expect(
      confirmPdsHead({ ...signed, hash: new Uint8Array(31) }, verify),
    ).rejects.toThrow('Invalid standard PDS head')
    await expect(
      confirmPdsHead({ ...signed, rev: 'not-a-tid' }, verify),
    ).rejects.toThrow('Invalid standard PDS head')
    for (const invalidRev of [`x${rev}`, `${rev}x`]) {
      await expect(
        confirmPdsHead({ ...signed, rev: invalidRev }, verify),
      ).rejects.toThrow('Invalid standard PDS head')
    }
    await expect(
      confirmPdsHead({ ...signed, did: 'not-a-did' }, verify),
    ).rejects.toThrow('Invalid standard PDS head')
  })

  it('excludes MST custody and missing heads without inventing hashes', async () => {
    const result = planStandardWriters(
      members,
      'general',
      new Map([[motoko, await head()]]),
    )
    expect(result.publishable).toBe(false)
    expect(result.rows).toEqual([
      { did: motoko, rev, hash: new Uint8Array(32).fill(7) },
    ])
    expect(result.blockers).toEqual([
      `MST custody has no standard head: ${asuka}`,
    ])
    expect(planStandardWriters(members, 'general', new Map()).blockers).toEqual(
      [
        `Missing verified PDS head: ${motoko}`,
        `MST custody has no standard head: ${asuka}`,
      ],
    )
    expect(
      planStandardWriters(
        members,
        'general',
        new Map([[motoko, await head(asuka)]]),
      ).blockers,
    ).toContain(`Missing verified PDS head: ${motoko}`)
    expect(
      planStandardWriters(
        members,
        'general',
        new Map([
          [
            motoko,
            {
              did: motoko,
              rev,
              hash: new Uint8Array(32),
            } as unknown as VerifiedPdsHead,
          ],
        ]),
      ).blockers,
    ).toContain(`Missing verified PDS head: ${motoko}`)
  })

  it('omits inactive and other-boundary members', async () => {
    const narrowed = [
      { ...members[0], active: false },
      { ...members[1], boundaries: ['other'] },
    ]
    expect(
      planStandardWriters(
        narrowed,
        'general',
        new Map([[motoko, await head()]]),
      ),
    ).toEqual({ rows: [], blockers: [], publishable: true })
  })

  it('advances only a known writer with a matching verified head', async () => {
    const current = await head()
    const next = await head(motoko, 9)
    const rows = [{ did: motoko, rev: current.rev, hash: current.hash }]
    const notification = {
      space,
      repo: motoko,
      rev: next.rev,
      hash: next.hash,
      issuer: motoko,
      audience: authority,
    }
    expect(
      advanceKnownWriter(rows, notification, authority, space, next),
    ).toEqual([{ did: motoko, rev: next.rev, hash: next.hash }])
    expect(rows[0].hash[0]).toBe(7)
    expect(() =>
      advanceKnownWriter([], notification, authority, space, next),
    ).toThrow('Notification cannot discover a writer')
    expect(() =>
      advanceKnownWriter(
        rows,
        { ...notification, issuer: asuka },
        authority,
        space,
        next,
      ),
    ).toThrow('Notification identity does not match the space')
    expect(() =>
      advanceKnownWriter(
        rows,
        { ...notification, space: 'at://did:web:another.test/space/feed' },
        authority,
        'at://did:web:another.test/space/feed',
        next,
      ),
    ).toThrow('Notification identity does not match the space')
    expect(() =>
      advanceKnownWriter(
        rows,
        notification,
        authority,
        'at://did:web:another.test/space/zone.stratos.space.feed/general',
        next,
      ),
    ).toThrow('Notification identity does not match the space')
    expect(() =>
      advanceKnownWriter(
        rows,
        { ...notification, audience: asuka },
        authority,
        space,
        next,
      ),
    ).toThrow('Notification identity does not match the space')
    expect(() =>
      advanceKnownWriter(
        rows,
        { ...notification, hash: current.hash },
        authority,
        space,
        next,
      ),
    ).toThrow('Notification does not match a verified PDS head')
    expect(() =>
      advanceKnownWriter(
        rows,
        { ...notification, space: `${space}-other` },
        authority,
        space,
        next,
      ),
    ).toThrow('Notification identity does not match the space')
    for (const mismatch of [
      { head: await head(asuka, 9), notification },
      { head: next, notification: { ...notification, rev: '3lqj7l6h6x223' } },
      {
        head: next,
        notification: { ...notification, hash: new Uint8Array(31) },
      },
      { head: next, notification: { ...notification, hash: current.hash } },
      {
        head: next,
        notification: { ...notification, hash: next.hash.slice(0, 31) },
      },
      {
        head: next,
        notification: {
          ...notification,
          hash: Uint8Array.from([...next.hash, 9]),
        },
      },
      {
        head: {
          did: motoko,
          rev,
          hash: next.hash,
        } as unknown as VerifiedPdsHead,
        notification,
      },
    ]) {
      expect(() =>
        advanceKnownWriter(
          rows,
          mismatch.notification,
          authority,
          space,
          mismatch.head,
        ),
      ).toThrow('Notification does not match a verified PDS head')
    }
    const oneByteChanged = Uint8Array.from(next.hash)
    oneByteChanged[0] = 0
    expect(() =>
      advanceKnownWriter(
        rows,
        { ...notification, hash: oneByteChanged },
        authority,
        space,
        next,
      ),
    ).toThrow('Notification does not match a verified PDS head')
    const second = { did: asuka, rev, hash: new Uint8Array(32).fill(4) }
    const updated = advanceKnownWriter(
      [second, ...rows],
      notification,
      authority,
      space,
      next,
    )
    expect(updated).toEqual([second, { did: motoko, rev, hash: next.hash }])
    second.hash.fill(0)
    expect(updated[0].hash[0]).toBe(4)
  })
})

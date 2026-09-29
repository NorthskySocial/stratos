import { describe, expect, it, vi } from 'vitest'
import {
  advanceKnownWriter,
  confirmPdsHead,
  planStandardWriters,
  type AuthorityMember,
  type StandardWriter,
  type VerifiedPdsHead,
  type WriteNotification,
} from './authority-contract.adapter.js'

const authority = 'did:web:motoko.test'
const space = `at://${authority}/space/zone.stratos.space.feed/general`
const rev = '3lqj7l6h6x222'
const motoko = 'did:plc:motokokusangai00000000'
const asuka = 'did:plc:asukalangley0000000000'

async function head(did = motoko, value = 7, spaceUri = space) {
  return confirmPdsHead(
    { space: spaceUri, did, rev, hash: new Uint8Array(32).fill(value) },
    async () => {},
  )
}

const members: AuthorityMember[] = [
  { did: motoko, custody: 'pds', active: true, boundaries: ['general'] },
  { did: asuka, custody: 'stratos', active: true, boundaries: ['general'] },
]

function advance(
  rows: readonly StandardWriter[],
  notification: WriteNotification,
  authorityDid: string,
  expectedSpace: string,
  verifiedHead: VerifiedPdsHead,
  currentMembers: readonly AuthorityMember[] = members,
  boundary = 'general',
): StandardWriter[] {
  return advanceKnownWriter(
    rows,
    notification,
    authorityDid,
    expectedSpace,
    boundary,
    currentMembers,
    verifiedHead,
  )
}

describe('sandbox standard writer fixture', () => {
  it('requires a validated PDS head before admitting a row', async () => {
    const verify = vi.fn().mockResolvedValue(undefined)
    const signed = { space, did: motoko, rev, hash: new Uint8Array(32).fill(7) }
    const confirmed = await confirmPdsHead(signed, verify)
    expect(verify).toHaveBeenCalledOnce()
    expect(verify).toHaveBeenCalledWith({
      space,
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
      space,
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
    await expect(
      confirmPdsHead({ ...signed, space: `${space}/extra` }, verify),
    ).rejects.toThrow('Invalid standard PDS head')
    await expect(
      confirmPdsHead({ ...signed, space: `prefix${space}` }, verify),
    ).rejects.toThrow('Invalid standard PDS head')
  })

  it('excludes MST custody and missing heads without inventing hashes', async () => {
    const result = planStandardWriters(
      members,
      'general',
      space,
      new Map([[motoko, await head()]]),
    )
    expect(result.publishable).toBe(false)
    expect(result.rows).toEqual([
      { did: motoko, rev, hash: new Uint8Array(32).fill(7) },
    ])
    expect(result.blockers).toEqual([
      `MST custody has no standard head: ${asuka}`,
    ])
    expect(
      planStandardWriters(members, 'general', space, new Map()).blockers,
    ).toEqual([
      `Missing verified PDS head: ${motoko}`,
      `MST custody has no standard head: ${asuka}`,
    ])
    expect(
      planStandardWriters(
        members,
        'general',
        space,
        new Map([[motoko, await head(asuka)]]),
      ).blockers,
    ).toContain(`Missing verified PDS head: ${motoko}`)
    expect(
      planStandardWriters(
        members,
        'general',
        space,
        new Map([
          [
            motoko,
            {
              space,
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
        space,
        new Map([[motoko, await head()]]),
      ),
    ).toEqual({ rows: [], blockers: [], publishable: true })
  })

  it('never admits a signed head verified for another space', async () => {
    const otherSpace = `at://${authority}/space/zone.stratos.space.feed/other`
    const otherHead = await head(motoko, 7, otherSpace)
    const result = planStandardWriters(
      [members[0]],
      'general',
      space,
      new Map([[motoko, otherHead]]),
    )
    expect(result.rows).toEqual([])
    expect(result.publishable).toBe(false)
    expect(result.blockers).toContain(`Missing verified PDS head: ${motoko}`)
    expect(() =>
      planStandardWriters([members[0]], 'general', `prefix${space}`, new Map()),
    ).toThrow('Invalid standard space URI')
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
    expect(advance(rows, notification, authority, space, next)).toEqual([
      { did: motoko, rev: next.rev, hash: next.hash },
    ])
    expect(rows[0].hash[0]).toBe(7)
    expect(() => advance([], notification, authority, space, next)).toThrow(
      'Notification cannot discover a writer',
    )
    expect(() =>
      advance(rows, { ...notification, issuer: asuka }, authority, space, next),
    ).toThrow('Notification identity does not match the space')
    expect(() =>
      advance(
        rows,
        { ...notification, space: 'at://did:web:another.test/space/feed' },
        authority,
        'at://did:web:another.test/space/feed',
        next,
      ),
    ).toThrow('Notification identity does not match the space')
    expect(() =>
      advance(
        rows,
        notification,
        authority,
        'at://did:web:another.test/space/zone.stratos.space.feed/general',
        next,
      ),
    ).toThrow('Notification identity does not match the space')
    expect(() =>
      advance(
        rows,
        { ...notification, audience: asuka },
        authority,
        space,
        next,
      ),
    ).toThrow('Notification identity does not match the space')
    expect(() =>
      advance(
        rows,
        { ...notification, hash: current.hash },
        authority,
        space,
        next,
      ),
    ).toThrow('Notification does not match a verified PDS head')
    expect(() =>
      advance(
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
          space,
          did: motoko,
          rev,
          hash: next.hash,
        } as unknown as VerifiedPdsHead,
        notification,
      },
    ]) {
      expect(() =>
        advance(rows, mismatch.notification, authority, space, mismatch.head),
      ).toThrow('Notification does not match a verified PDS head')
    }
    const oneByteChanged = Uint8Array.from(next.hash)
    oneByteChanged[0] = 0
    expect(() =>
      advance(
        rows,
        { ...notification, hash: oneByteChanged },
        authority,
        space,
        next,
      ),
    ).toThrow('Notification does not match a verified PDS head')
    const second = { did: asuka, rev, hash: new Uint8Array(32).fill(4) }
    const updated = advance(
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

  it('rechecks current membership before advancing a retained writer row', async () => {
    const verifiedHead = await head(motoko, 9)
    const rows = [{ did: motoko, rev, hash: new Uint8Array(32).fill(7) }]
    const notification = {
      space,
      repo: motoko,
      rev,
      hash: verifiedHead.hash,
      issuer: motoko,
      audience: authority,
    }
    for (const currentMembers of [
      [],
      [{ ...members[0], active: false }],
      [{ ...members[0], boundaries: ['other'] }],
      [{ ...members[0], custody: 'stratos' as const }],
      [
        { ...members[1], custody: 'pds' as const },
        { ...members[0], active: false },
      ],
    ]) {
      expect(() =>
        advance(
          rows,
          notification,
          authority,
          space,
          verifiedHead,
          currentMembers,
        ),
      ).toThrow('Notification writer is not an active space member')
    }
    expect(() =>
      advance(
        rows,
        notification,
        authority,
        space,
        verifiedHead,
        members,
        'other',
      ),
    ).toThrow('Notification writer is not an active space member')
    expect(rows[0].hash[0]).toBe(7)
  })

  it('rejects a notification head bound to another space', async () => {
    const otherSpace = `at://${authority}/space/zone.stratos.space.feed/other`
    const verifiedHead = await head(motoko, 9, otherSpace)
    const notification = {
      space,
      repo: motoko,
      rev,
      hash: verifiedHead.hash,
      issuer: motoko,
      audience: authority,
    }
    expect(() =>
      advance(
        [{ did: motoko, rev, hash: new Uint8Array(32).fill(7) }],
        notification,
        authority,
        space,
        verifiedHead,
      ),
    ).toThrow('Notification does not match a verified PDS head')
  })
})

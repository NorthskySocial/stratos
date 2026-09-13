import { describe, expect, it } from 'vitest'
import { Secp256k1Keypair, P256Keypair, verifySignature } from '@atproto/crypto'
import {
  appendServiceKeyHistory,
  verifyServiceKeyHistory,
  findHistoricalSigningKey,
  keyHistoryTimestamp,
  MAX_KEY_HISTORY_ENTRIES,
} from '../src/key-history.js'
import { encode, toBytes } from '@atcute/cbor'
import { createHash } from 'node:crypto'
import type { ServiceKeyHistory } from '../src/key-history.js'

const did = 'did:web:nerv.example'
const firstTime = '1995-10-04T00:00:00.000Z'
const secondTime = '1995-10-05T00:00:00.000Z'
async function fixture() {
  const shinji = await Secp256k1Keypair.create({ exportable: true })
  const rei = await P256Keypair.create({ exportable: true })
  const genesis = await appendServiceKeyHistory(
    { serviceDid: did, entries: [] },
    shinji,
    shinji,
    firstTime,
  )
  const history = await appendServiceKeyHistory(
    genesis,
    shinji,
    rei,
    secondTime,
  )
  return { shinji, rei, genesis, history }
}

describe('service signing key history', () => {
  it('verifies genesis and rotations across key types without changing existing entries', async () => {
    const { shinji, rei, genesis, history } = await fixture()
    expect(history.entries).toHaveLength(2)
    expect(history.entries[0]).toEqual(genesis.entries[0])
    expect(history.entries[1].previousVersionId).toBe(
      genesis.entries[0].versionId,
    )
    expect(await verifyServiceKeyHistory(genesis, did, shinji.did())).toEqual(
      genesis,
    )
    expect(await verifyServiceKeyHistory(history, did, rei.did())).toEqual(
      history,
    )
    expect(history.entries[0].versionId).toMatch(/^1-[a-f0-9]{64}$/)
    expect(history.entries[1].versionId).toMatch(/^2-[a-f0-9]{64}$/)
  })
  it.each([
    null,
    {},
    { serviceDid: did, entries: [] },
    { serviceDid: did, entries: {} },
    { serviceDid: 'did:web:seele.example', entries: [null] },
    {
      serviceDid: did,
      entries: Array.from({ length: MAX_KEY_HISTORY_ENTRIES + 1 }, () => null),
    },
  ])('rejects malformed or oversized logs', async (history) => {
    await expect(
      verifyServiceKeyHistory(history, did, 'did:key:zFake'),
    ).rejects.toThrow('Invalid service key history')
  })
  it('requires a web DID', async () => {
    await expect(
      appendServiceKeyHistory(
        { serviceDid: 'did:plc:nerv', entries: [] },
        await Secp256k1Keypair.create(),
        await Secp256k1Keypair.create(),
        firstTime,
      ),
    ).rejects.toThrow()
    const { history, rei } = await fixture()
    await expect(
      verifyServiceKeyHistory(
        { ...history, serviceDid: 'did:plc:nerv' },
        'did:plc:nerv',
        rei.did(),
      ),
    ).rejects.toThrow('Invalid service key history')
  })
  it.each(['invalid', '1995-10-04T00:00:00Z'])(
    'rejects noncanonical timestamps %s',
    (time) => {
      expect(() => keyHistoryTimestamp(time)).toThrow('canonical UTC')
    },
  )
  it('returns millisecond timestamps', () =>
    expect(keyHistoryTimestamp(firstTime)).toBe(812764800000))
  it.each([
    'versionId',
    'previousVersionId',
    'key',
    'validFrom',
    'proof',
    'acceptance',
  ])('rejects tampered %s', async (field) => {
    const { history, rei } = await fixture()
    const entry = history.entries[1] as unknown as Record<string, unknown>
    entry[field] =
      field === 'proof' || field === 'acceptance'
        ? btoa('forged signature')
        : 'forged'
    await expect(
      verifyServiceKeyHistory(history, did, rei.did()),
    ).rejects.toThrow()
  })
  it.each(['key', 'validFrom', 'proof', 'acceptance'])(
    'rejects non-string %s',
    async (field) => {
      const { history, rei } = await fixture()
      ;(history.entries[0] as unknown as Record<string, unknown>)[field] = 42
      await expect(
        verifyServiceKeyHistory(history, did, rei.did()),
      ).rejects.toThrow('Invalid key history entry')
    },
  )
  it('rejects null entries, reused keys, out-of-order times and wrong anchors', async () => {
    const { history, genesis, shinji, rei } = await fixture()
    await expect(
      verifyServiceKeyHistory({ ...history, entries: [null] }, did, rei.did()),
    ).rejects.toThrow('Invalid key history entry')
    await expect(
      appendServiceKeyHistory(genesis, shinji, shinji, secondTime),
    ).rejects.toThrow('Invalid key history entry')
    for (const time of [firstTime, '1995-10-03T00:00:00.000Z']) {
      await expect(
        appendServiceKeyHistory(genesis, shinji, rei, time),
      ).rejects.toThrow('timestamps must increase')
    }
    await expect(
      verifyServiceKeyHistory(history, did, shinji.did()),
    ).rejects.toThrow('current DID key')
    await expect(
      appendServiceKeyHistory(genesis, rei, shinji, secondTime),
    ).rejects.toThrow('current DID key')
  })
  it('rejects a forged parallel history authorized only by an attacker', async () => {
    const { rei } = await fixture()
    const kaworu = await Secp256k1Keypair.create()
    const parallel = await appendServiceKeyHistory(
      { serviceDid: did, entries: [] },
      kaworu,
      kaworu,
      firstTime,
    )
    await expect(
      appendServiceKeyHistory(
        parallel,
        kaworu,
        {
          did: () => rei.did(),
          sign: (bytes) => kaworu.sign(bytes),
        },
        secondTime,
      ),
    ).rejects.toThrow('acceptance signature failed')
  })
  it('rejects an update not authorized by the prior key', async () => {
    const { genesis, shinji, rei } = await fixture()
    const kaworu = await Secp256k1Keypair.create()
    await expect(
      appendServiceKeyHistory(
        genesis,
        { did: () => shinji.did(), sign: (bytes) => kaworu.sign(bytes) },
        rei,
        secondTime,
      ),
    ).rejects.toThrow('authorization signature failed')
  })
  it('uses inclusive start and exclusive end windows', async () => {
    const { history, shinji, rei } = await fixture()
    expect(findHistoricalSigningKey(history, shinji.did(), firstTime)).toBe(
      shinji.did(),
    )
    expect(findHistoricalSigningKey(history, rei.did(), secondTime)).toBe(
      rei.did(),
    )
    expect(
      findHistoricalSigningKey(history, rei.did(), '1995-10-06T00:00:00.000Z'),
    ).toBe(rei.did())
    for (const [key, time] of [
      [shinji.did(), secondTime],
      [shinji.did(), '1995-10-03T23:59:59.999Z'],
      [rei.did(), firstTime],
      ['did:key:zUnknown', firstTime],
    ]) {
      expect(() => findHistoricalSigningKey(history, key, time)).toThrow(
        'authorized time window',
      )
    }
  })
})

it('matches the independent canonical wire format and binds the prior version', async () => {
  const { history, shinji, rei } = await fixture()
  for (const [index, entry] of history.entries.entries()) {
    const bytes = encode({
      type: 'zone.stratos.identity.keyHistory',
      serviceDid: did,
      key: entry.key,
      validFrom: entry.validFrom,
      previousVersionId: entry.previousVersionId,
    })
    expect(entry.versionId).toBe(
      `${index + 1}-${createHash('sha256').update(bytes).digest('hex')}`,
    )
    expect(
      await verifySignature(
        index === 0 ? shinji.did() : history.entries[index - 1].key,
        encode({
          type: 'zone.stratos.identity.keyHistory',
          purpose: 'authorize',
          versionId: entry.versionId,
          entry: toBytes(bytes),
        }),
        Buffer.from(entry.proof, 'base64'),
      ),
    ).toBe(true)
    expect(
      await verifySignature(
        entry.key,
        encode({
          type: 'zone.stratos.identity.keyHistory',
          purpose: 'accept',
          versionId: entry.versionId,
          entry: toBytes(bytes),
        }),
        Buffer.from(entry.acceptance, 'base64'),
      ),
    ).toBe(true)
  }
  const entry = history.entries[1]
  entry.previousVersionId = '1-forged'
  const bytes = encode({
    type: 'zone.stratos.identity.keyHistory',
    serviceDid: did,
    key: entry.key,
    validFrom: entry.validFrom,
    previousVersionId: entry.previousVersionId,
  })
  entry.versionId = `2-${createHash('sha256').update(bytes).digest('hex')}`
  entry.proof = Buffer.from(
    await shinji.sign(
      encode({
        type: 'zone.stratos.identity.keyHistory',
        purpose: 'authorize',
        versionId: entry.versionId,
        entry: toBytes(bytes),
      }),
    ),
  ).toString('base64')
  entry.acceptance = Buffer.from(
    await rei.sign(
      encode({
        type: 'zone.stratos.identity.keyHistory',
        purpose: 'accept',
        versionId: entry.versionId,
        entry: toBytes(bytes),
      }),
    ),
  ).toString('base64')
  await expect(
    verifyServiceKeyHistory(history, did, rei.did()),
  ).rejects.toThrow('Invalid key history entry')
})

it('requires self-authorization of genesis and reports corrupted hashes', async () => {
  const { shinji, rei, history } = await fixture()
  await expect(
    appendServiceKeyHistory(
      { serviceDid: did, entries: [] },
      shinji,
      rei,
      firstTime,
    ),
  ).rejects.toThrow('Genesis requires its own signing key')
  history.entries[1].versionId = 'forged'
  await expect(
    verifyServiceKeyHistory(history, did, rei.did()),
  ).rejects.toThrow('Key history hash chain mismatch')
  await expect(
    verifyServiceKeyHistory(
      {
        serviceDid: did,
        entries: Array.from({ length: MAX_KEY_HISTORY_ENTRIES }, () => null),
      },
      did,
      rei.did(),
    ),
  ).rejects.toThrow('Invalid key history entry')
})

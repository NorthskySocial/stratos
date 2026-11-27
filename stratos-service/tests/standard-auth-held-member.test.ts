import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import type { AppContext } from '../src/context.js'
import type { DpopVerifier } from '../src/infra/auth/dpop-verifier.js'
import { createAuthVerifiers } from '../src/infra/auth/verifiers.js'
import {
  asMember,
  HARNESS_ENGINEERING,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const HELD_PILOT = 'did:plc:asuka-langley'
const NOT_ENROLLED = {
  error: 'NotEnrolled',
  message: 'User is not enrolled in this Stratos service',
}

type StandardVerifier = AppContext['authVerifier']['standard']

/** A DPoP verifier that accepts every proof as the given member's. */
function dpopVerifierFor(did: string): DpopVerifier {
  return {
    verify: async () => ({ did, jkt: 'jkt-unit-02' }),
    nextNonce: () => undefined,
  } as unknown as DpopVerifier
}

async function refusalOf(
  verifier: StandardVerifier,
  authorization: string,
): Promise<unknown> {
  const refused = verifier({
    req: {
      method: 'POST',
      url: '/xrpc/zone.stratos.repo.createRecord',
      headers: { authorization },
    },
    res: { setHeader: () => undefined },
  } as never).then(
    () => undefined,
    (error: unknown) => error,
  )
  const error = await refused
  if (!(error instanceof Error)) throw new Error('the verifier admitted')
  const { type, customErrorName, message } = error as Error & {
    type?: number
    customErrorName?: string
  }
  return { status: type, customErrorName, message }
}

describe('a held member under the standard verifier', () => {
  let harness: WriteHarness

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(HELD_PILOT, [HARNESS_ENGINEERING])
    await harness.holdMember(HELD_PILOT)
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  }, 60_000)

  it('is refused with NotEnrolled over HTTP in dev mode, not with a 500', async () => {
    const write = await harness.call(
      'zone.stratos.repo.createRecord',
      asMember(HELD_PILOT),
      {
        boundary: HARNESS_ENGINEERING,
        repo: HELD_PILOT,
        collection: 'zone.stratos.feed.post',
        record: {
          $type: 'zone.stratos.feed.post',
          text: 'Anta baka?',
          createdAt: '1995-10-04T00:00:00.000Z',
        },
      },
    )
    const exported = await harness.query(
      'zone.stratos.sync.getRepo',
      asMember(HELD_PILOT),
      { did: HELD_PILOT },
    )

    expect(write).toEqual({ status: 400, body: NOT_ENROLLED })
    expect(exported).toEqual({ status: 400, body: NOT_ENROLLED })
  })

  it('answers the dev bearer exactly as it answers DPoP for the same member', async () => {
    const verifiers = createAuthVerifiers(
      harness.ctx.serviceDid,
      {} as IdResolver,
      harness.ctx.cfg,
      harness.ctx.enrollmentStore,
      {} as never,
      {} as never,
      [],
      dpopVerifierFor(HELD_PILOT),
      undefined,
      true,
      await Secp256k1Keypair.create(),
      undefined,
    )

    const overDpop = await refusalOf(verifiers.standard, 'DPoP unit-02-token')
    const overDevBearer = await refusalOf(
      verifiers.standard,
      `Bearer ${HELD_PILOT}`,
    )

    expect(overDpop).toEqual({
      status: 400,
      customErrorName: NOT_ENROLLED.error,
      message: NOT_ENROLLED.message,
    })
    expect(overDevBearer).toEqual(overDpop)
  })
})

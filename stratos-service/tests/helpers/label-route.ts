import http from 'node:http'
import express from 'express'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  RECORD_SUBJECT_TYPE,
  stratosLexicons,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../src/context.js'
import {
  CREATE_LABEL_METHOD,
  registerModerationHandlers,
} from '../../src/features/moderation/index.js'
import { createModerationServiceVerifier } from '../../src/infra/auth/verifiers.js'
import type { WriteHarness } from './write-harness.js'

export interface LabelRoute {
  takeDownRecord(uri: string): Promise<number>
  close(): Promise<void>
}

/**
 * The real createLabel route and moderation-service verifier over the
 * harness's stores. The moderator's key is local and its DID document is
 * served by a resolver that forwards every other DID to the real one.
 */
export async function startLabelRoute(
  harness: WriteHarness,
): Promise<LabelRoute> {
  const moderator = await Secp256k1Keypair.create({ exportable: true })
  const document = {
    id: moderator.did(),
    verificationMethod: [
      {
        id: `${moderator.did()}#key`,
        type: 'Multikey',
        controller: moderator.did(),
        publicKeyMultibase: moderator.did().slice('did:key:'.length),
      },
    ],
  }
  const realResolver = harness.ctx.idResolver
  const resolver = {
    did: {
      resolve: (did: string) =>
        did === moderator.did()
          ? Promise.resolve(document)
          : realResolver.did.resolve(did),
    },
  } as unknown as IdResolver
  const ctx: AppContext = {
    ...harness.ctx,
    authVerifier: {
      ...harness.ctx.authVerifier,
      moderationService: createModerationServiceVerifier({
        serviceDid: harness.ctx.serviceDid,
        idResolver: resolver,
        allowedIssuers: [moderator.did()],
      }),
    },
  }
  const server = new XrpcServer(stratosLexicons)
  registerModerationHandlers(server, ctx)
  const app = express()
  app.use(server.router)
  const listening: http.Server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started))
  })
  const { port } = listening.address() as { port: number }

  return {
    async takeDownRecord(uri) {
      const jwt = await createServiceJwt({
        iss: moderator.did(),
        aud: harness.ctx.serviceDid,
        lxm: CREATE_LABEL_METHOD,
        keypair: moderator,
      })
      const response = await fetch(
        `http://127.0.0.1:${port}/xrpc/${CREATE_LABEL_METHOD}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({
            subject: { $type: RECORD_SUBJECT_TYPE, uri },
            val: '!takedown',
          }),
        },
      )
      return response.status
    },
    close: () =>
      new Promise<void>((resolve) => {
        listening.close(() => resolve())
      }),
  }
}

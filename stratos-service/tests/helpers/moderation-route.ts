import http from 'node:http'
import express from 'express'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import { stratosLexicons } from '@northskysocial/stratos-core'
import type { AppContext } from '../../src/context.js'
import {
  CREATE_LABEL_METHOD,
  QUERY_LABELS_METHOD,
  registerModerationHandlers,
} from '../../src/features/moderation/index.js'
import { createModerationServiceVerifier } from '../../src/infra/auth/verifiers.js'
import type { CallResult, WriteHarness } from './write-harness.js'

export interface ModerationRoute {
  createLabel(subject: unknown): Promise<CallResult>
  queryLabels(params: URLSearchParams): Promise<CallResult>
  close(): Promise<void>
}

/**
 * The real createLabel and queryLabels routes over the harness's stores, called
 * as a moderation service whose key is local and whose DID document a resolver
 * serves; every other DID goes to the real resolver.
 */
export async function startModerationRoute(
  harness: WriteHarness,
): Promise<ModerationRoute> {
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
  const moderationService = createModerationServiceVerifier({
    serviceDid: harness.ctx.serviceDid,
    idResolver: resolver,
    allowedIssuers: [moderator.did()],
  })
  const ctx: AppContext = {
    ...harness.ctx,
    authVerifier: {
      ...harness.ctx.authVerifier,
      moderationService,
      moderationServiceOrService: moderationService,
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

  const token = (method: string) =>
    createServiceJwt({
      iss: moderator.did(),
      aud: harness.ctx.serviceDid,
      lxm: method,
      keypair: moderator,
    })

  async function answer(response: Response): Promise<CallResult> {
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }

  return {
    async createLabel(subject) {
      return answer(
        await fetch(`http://127.0.0.1:${port}/xrpc/${CREATE_LABEL_METHOD}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await token(CREATE_LABEL_METHOD)}`,
          },
          body: JSON.stringify({ subject, val: '!takedown' }),
        }),
      )
    },
    async queryLabels(params) {
      return answer(
        await fetch(
          `http://127.0.0.1:${port}/xrpc/${QUERY_LABELS_METHOD}?${params}`,
          {
            headers: {
              authorization: `Bearer ${await token(QUERY_LABELS_METHOD)}`,
            },
          },
        ),
      )
    },
    close: () =>
      new Promise<void>((resolve) => {
        listening.close(() => resolve())
      }),
  }
}

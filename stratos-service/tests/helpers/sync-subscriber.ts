import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import WebSocket from 'ws'
import { Secp256k1Keypair } from '@atproto/crypto'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { decodeAll } from '@atproto/lex-cbor'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import { stratosLexicons } from '@northskysocial/stratos-core'
import type { AppContext } from '../../src/context.js'
import { createSubscribeAuthVerifier } from '../../src/infra/auth/verifiers.js'
import { registerSubscribeRecords } from '../../src/subscription/index.js'
import { HARNESS_SERVICE_DID, type WriteHarness } from './write-harness.js'

const SUBSCRIBE_METHOD = 'zone.stratos.sync.subscribeRecords'
const FRAME_TIMEOUT_MS = 15_000

export interface FrameOp {
  action: string
  path: string
  cid?: string
  record?: unknown
  boundary?: { values: Array<{ value: string }> }
}

export interface CommitFrame {
  /** The length of the frame as it crossed the websocket. */
  bytes: number
  seq: number
  ops: FrameOp[]
}

export interface SyncSubscriber {
  /**
   * Reads one actor's commit frames from a cursor and resolves with every
   * frame up to and including the first that `isLast` accepts.
   */
  readCommitFrames(
    actorDid: string,
    cursor: number,
    isLast: (frame: CommitFrame) => boolean,
  ): Promise<CommitFrame[]>
  close(): Promise<void>
}

function didDocumentFor(keypair: Secp256k1Keypair) {
  return {
    id: keypair.did(),
    verificationMethod: [
      {
        id: `${keypair.did()}#key`,
        type: 'Multikey',
        controller: keypair.did(),
        publicKeyMultibase: keypair.did().slice('did:key:'.length),
      },
    ],
  }
}

/**
 * Enrolls a peer service in boundaries and serves the real subscribeRecords
 * route over a websocket that peer can read, signed with its own key.
 */
export async function startSyncSubscriber(
  harness: WriteHarness,
  subscriberDid: string,
  boundaries: string[],
): Promise<SyncSubscriber> {
  await harness.enrollServiceIdentity(subscriberDid, boundaries)
  const keypair = await Secp256k1Keypair.create()
  const didCache = new MemoryCache()
  await didCache.cacheDid(subscriberDid, didDocumentFor(keypair))

  const subscribeCtx = {
    ...harness.ctx,
    xrpcServer: new XrpcServer(stratosLexicons),
    authVerifier: {
      ...harness.ctx.authVerifier,
      subscribeAuth: createSubscribeAuthVerifier(
        new IdResolver({ didCache }),
        HARNESS_SERVICE_DID,
      ),
    },
  } as AppContext
  registerSubscribeRecords(subscribeCtx)
  const app = express()
  app.use(subscribeCtx.xrpcServer.router)
  const server: http.Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const { port } = server.address() as AddressInfo

  return {
    async readCommitFrames(actorDid, cursor, isLast) {
      const jwt = await createServiceJwt({
        iss: subscriberDid,
        aud: HARNESS_SERVICE_DID,
        lxm: SUBSCRIBE_METHOD,
        keypair,
      })
      const url = `ws://127.0.0.1:${port}/xrpc/${SUBSCRIBE_METHOD}?did=${encodeURIComponent(actorDid)}&cursor=${cursor}`
      return new Promise((resolve, reject) => {
        const frames: CommitFrame[] = []
        const socket = new WebSocket(url, {
          headers: { authorization: `Bearer ${jwt}` },
        })
        const timer = setTimeout(() => {
          socket.terminate()
          reject(new Error(`timed out after ${frames.length} commit frames`))
        }, FRAME_TIMEOUT_MS)
        socket.on('message', (data: Buffer, isBinary: boolean) => {
          if (!isBinary) return
          const [header, body] = [...decodeAll(new Uint8Array(data))] as [
            { t?: string },
            { seq: number; ops: FrameOp[] },
          ]
          // A cursor can draw an #info notice ahead of the commits.
          if (header.t !== '#commit') return
          const frame = { bytes: data.length, seq: body.seq, ops: body.ops }
          frames.push(frame)
          if (isLast(frame)) {
            clearTimeout(timer)
            socket.close()
            resolve(frames)
          }
        })
        socket.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

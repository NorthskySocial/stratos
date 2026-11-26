import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { TestServer } from './helpers/test-server.js'

const PILOT = 'did:plc:rei-ayanami'
const RAW_CODEC = 0x55
const IMAGE = new TextEncoder().encode('lilith core sample')

async function rawCidOf(bytes: Uint8Array): Promise<string> {
  return CID.createV1(RAW_CODEC, await sha256.digest(bytes)).toString()
}

describe('uploadBlob over HTTP against the full server assembly', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await TestServer.create()
    await server.start()
    const { ctx } = server.server
    await ctx.actorStore.create(PILOT)
    await ctx.enrollmentStore.enroll({
      did: PILOT,
      enrolledAt: new Date().toISOString(),
      signingKeyDid: await ctx.actorSigner.getPublicKey(PILOT),
      active: true,
    })
  }, 60_000)

  afterAll(async () => {
    await server?.stop()
  }, 60_000)

  it.each(['com.atproto.repo.uploadBlob', 'zone.stratos.repo.uploadBlob'])(
    '%s stores the bytes and answers with their blob ref',
    async (nsid) => {
      const response = await fetch(`${server.url}/xrpc/${nsid}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${PILOT}`,
          'content-type': 'image/png',
        },
        body: IMAGE,
      })

      expect({
        status: response.status,
        body: (await response.json()) as unknown,
      }).toEqual({
        status: 200,
        body: {
          blob: {
            $type: 'blob',
            ref: { $link: await rawCidOf(IMAGE) },
            mimeType: 'image/png',
            size: IMAGE.length,
          },
        },
      })
    },
  )
})

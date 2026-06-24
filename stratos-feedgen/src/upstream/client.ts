import { Readable } from 'node:stream'
import type { Keypair } from '@atproto/crypto'

import { StratosClientError } from './errors.js'
import { mintServiceJwt } from './jwt.js'

const LXM = {
  resolveEnrollments: 'zone.stratos.identity.resolveEnrollments',
  hydrateRecords: 'zone.stratos.repo.hydrateRecords',
  getBlob: 'com.atproto.sync.getBlob',
  subscribeRecords: 'zone.stratos.sync.subscribeRecords',
} as const

export interface UpstreamStratosClientOptions {
  /** Base URL of the upstream Stratos service (no trailing slash). */
  serviceUrl: string
  /** DID of the upstream Stratos service. */
  serviceDid: string
  /** DID of this feed generator (used as JWT issuer). */
  feedgenDid: string
  /** Signing keypair for service-auth JWTs. */
  keypair: Keypair
  /** Optional fetch implementation override (test injection). */
  fetch?: typeof fetch
}

export interface ResolveEnrollmentsResult {
  did: string
  enrolled: boolean
  boundaries: string[]
}

export interface HydratedRecord {
  uri: string
  cid: string
  value: unknown
}

export interface HydrateRecordsResult {
  records: HydratedRecord[]
  notFound: string[]
  blocked: string[]
}

export interface GetBlobResult {
  stream: Readable
  contentType: string
  contentLength?: number
}

/**
 * Typed RPC client for the single upstream Stratos service this feed generator
 * federates with.
 */
export class UpstreamStratosClient {
  private readonly serviceUrl: string
  private readonly serviceDid: string
  private readonly feedgenDid: string
  private readonly keypair: Keypair
  private readonly fetchImpl: typeof fetch

  constructor(opts: UpstreamStratosClientOptions) {
    this.serviceUrl = opts.serviceUrl.endsWith('/')
      ? opts.serviceUrl.slice(0, -1)
      : opts.serviceUrl
    this.serviceDid = opts.serviceDid
    this.feedgenDid = opts.feedgenDid
    this.keypair = opts.keypair
    this.fetchImpl = opts.fetch ?? fetch
  }

  async resolveEnrollments(did: string): Promise<ResolveEnrollmentsResult> {
    const url = new URL(`${this.serviceUrl}/xrpc/${LXM.resolveEnrollments}`)
    url.searchParams.set('did', did)
    const lxm = LXM.resolveEnrollments
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await this.mintFor(lxm)}`,
        accept: 'application/json',
      },
    })
    await throwIfNotOk(res, url.toString(), lxm)
    return (await res.json()) as ResolveEnrollmentsResult
  }

  async hydrateRecords(uris: string[]): Promise<HydrateRecordsResult> {
    const url = `${this.serviceUrl}/xrpc/${LXM.hydrateRecords}`
    const lxm = LXM.hydrateRecords
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.mintFor(lxm)}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ uris }),
    })
    await throwIfNotOk(res, url, lxm)
    return (await res.json()) as HydrateRecordsResult
  }

  async getBlob(did: string, cid: string): Promise<GetBlobResult> {
    const url = new URL(`${this.serviceUrl}/xrpc/${LXM.getBlob}`)
    url.searchParams.set('did', did)
    url.searchParams.set('cid', cid)
    const lxm = LXM.getBlob
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await this.mintFor(lxm)}`,
      },
    })
    await throwIfNotOk(res, url.toString(), lxm)
    if (!res.body) {
      throw new StratosClientError({
        status: res.status,
        body: '',
        url: url.toString(),
        lxm,
        message: 'getBlob returned no body',
      })
    }
    const contentLengthHeader = res.headers.get('content-length')
    return {
      stream: Readable.fromWeb(res.body as never),
      contentType:
        res.headers.get('content-type') ?? 'application/octet-stream',
      contentLength: contentLengthHeader
        ? Number(contentLengthHeader)
        : undefined,
    }
  }

  async mintServiceAuthToken(): Promise<string> {
    return this.mintFor(LXM.subscribeRecords)
  }

  private mintFor(lxm: string): Promise<string> {
    return mintServiceJwt({
      lxm,
      iss: this.feedgenDid,
      aud: this.serviceDid,
      keypair: this.keypair,
    })
  }
}

async function throwIfNotOk(
  res: Response,
  url: string,
  lxm: string,
): Promise<void> {
  if (res.ok) return
  let body = ''
  try {
    body = await res.text()
  } catch {
    // ignore body read errors
  }
  throw new StratosClientError({
    status: res.status,
    body,
    url,
    lxm,
  })
}

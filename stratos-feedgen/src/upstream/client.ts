import { Readable } from 'node:stream'
import type { Keypair } from '@atproto/crypto'
import type { Custody } from '@northskysocial/stratos-core'

import { StratosClientError, StratosInvalidResponseError } from './errors.js'
import { mintServiceJwt } from './jwt.js'

const LXM = {
  resolveEnrollments: 'zone.stratos.identity.resolveEnrollments',
  hydrateRecords: 'zone.stratos.repo.hydrateRecords',
  getBlob: 'com.atproto.sync.getBlob',
  subscribeRecords: 'zone.stratos.sync.subscribeRecords',
  getSpaceCredential: 'zone.stratos.space.getSpaceCredential',
  listSpaceRepos: 'zone.stratos.space.listRepos',
} as const

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export interface UpstreamStratosClientOptions {
  /** Base URL this client sends requests to (no trailing slash). May be internal-only. */
  serviceUrl: string
  /**
   * Base URL Stratos verifies the space-surface DPoP `htu` against
   * (`STRATOS_PUBLIC_URL` server-side — see `space-dpop.ts`). Defaults to
   * `serviceUrl`. Set this separately when the feedgen reaches Stratos on an
   * internal address that differs from Stratos's externally-known origin, or
   * every space-credential mint fails with `ProofRequired`.
   */
  publicUrl?: string
  /** DID of the upstream Stratos service. */
  serviceDid: string
  /** DID of this feed generator (used as JWT issuer). */
  feedgenDid: string
  /** Signing keypair for service-auth JWTs. */
  keypair: Keypair
  /** Optional fetch implementation override (test injection). */
  fetch?: typeof fetch
  /** Timeout for membership listing and credential-mint requests. */
  requestTimeoutMs?: number
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

export interface GetSpaceCredentialResult {
  credential: string
  expiresAt: string
}

export interface GetSpaceCredentialOptions {
  /** The space's `at://` URI to request a credential for. */
  space: string
  /** Self-minted `atproto-space-delegation+jwt` establishing the caller's identity. */
  delegationToken: string
  /**
   * Builds the standalone mint-time DPoP proof (no `ath`) for the given
   * absolute request URL. Key material lives with the caller, not this
   * client, so proof construction is injected rather than owned here.
   */
  buildMintProof: (htu: string) => Promise<string>
}

/**
 * Structural subset of `SpaceCredentialManager`'s `HeldSpaceCredential` this
 * client needs to present a space credential. Declared locally, rather than
 * imported, so `upstream/` does not depend on `space-credential/`.
 */
export interface SpaceCredentialProof {
  /** The space-credential JWT, presented in the `authorization` header. */
  readonly credential: string
  /** Builds a fresh presentation-proof DPoP header bound to the credential via `ath`. */
  readonly createPresentationProof: (
    htm: string,
    htu: string,
  ) => Promise<string>
}

export interface ListSpaceReposOptions {
  /** The space's `at://` URI to list member repos for. */
  space: string
  cursor?: string
  limit?: number
}

/** Spec-shaped mirror of a `com.atproto.space.listRepos` entry, extended with `host`/`hostSource`. */
export interface SpaceRepoEntry {
  did: string
  /** Fail-closed normalization: anything except an explicit `pds` is `stratos`. */
  custody: Custody
  /** Present only for a stratos-custody member. */
  rev?: string
  /** The resolved repo host, if resolvable. */
  host?: string
  hostSource?: 'authority-override' | 'did-document'
}

export interface ListSpaceReposResult {
  repos: SpaceRepoEntry[]
  cursor?: string
}

/**
 * Typed RPC client for the single upstream Stratos service this feed generator
 * federates with.
 */
export class UpstreamStratosClient {
  private readonly serviceUrl: string
  private readonly publicUrl: string
  private readonly serviceDid: string
  private readonly feedgenDid: string
  private readonly keypair: Keypair
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number

  constructor(opts: UpstreamStratosClientOptions) {
    this.serviceUrl = trimTrailingSlash(opts.serviceUrl)
    this.publicUrl = trimTrailingSlash(opts.publicUrl ?? opts.serviceUrl)
    this.serviceDid = opts.serviceDid
    this.feedgenDid = opts.feedgenDid
    this.keypair = opts.keypair
    this.fetchImpl = opts.fetch ?? fetch
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async resolveEnrollments(did: string): Promise<ResolveEnrollmentsResult> {
    const url = new URL(`${this.serviceUrl}/xrpc/${LXM.resolveEnrollments}`)
    url.searchParams.set('did', did)
    const lxm = LXM.resolveEnrollments
    const res = await this.fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(this.requestTimeoutMs),
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

  /**
   * Exchange a self-minted delegation token for a space credential.
   *
   * Identity flows through the delegation token, not an `Authorization`
   * header, so this sends only the mint-time `dpop` proof the endpoint
   * requires to bind the credential (see
   * `stratos-service/src/features/space-credential/handler.ts`).
   */
  async getSpaceCredential(
    opts: GetSpaceCredentialOptions,
  ): Promise<GetSpaceCredentialResult> {
    const path = `/xrpc/${LXM.getSpaceCredential}`
    const url = `${this.serviceUrl}${path}`
    const lxm = LXM.getSpaceCredential
    // The proof's `htu` must match what Stratos verifies against
    // (`STRATOS_PUBLIC_URL`), which can differ from `serviceUrl` — the
    // address this client actually sends the request to.
    const htu = `${this.publicUrl}${path}`
    const res = await this.fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        dpop: await opts.buildMintProof(htu),
      },
      body: JSON.stringify({
        space: opts.space,
        delegationToken: opts.delegationToken,
      }),
    })
    await throwIfNotOk(res, url, lxm)
    return (await res.json()) as GetSpaceCredentialResult
  }

  /**
   * List the members of a space this feedgen is syncing, via the Stratos
   * mirror of `com.atproto.space.listRepos`. Authenticated with a space
   * credential, presented the same way a foreign host later verifies it: a
   * `DPoP <credential>` authorization header plus a fresh presentation proof.
   */
  async listSpaceRepos(
    opts: ListSpaceReposOptions,
    credentialProof: SpaceCredentialProof,
    signal?: AbortSignal,
  ): Promise<ListSpaceReposResult> {
    const path = `/xrpc/${LXM.listSpaceRepos}`
    const url = new URL(`${this.serviceUrl}${path}`)
    url.searchParams.set('space', opts.space)
    if (opts.limit !== undefined) {
      url.searchParams.set('limit', String(opts.limit))
    }
    if (opts.cursor !== undefined) {
      url.searchParams.set('cursor', opts.cursor)
    }
    const lxm = LXM.listSpaceRepos
    // Same htu convention as getSpaceCredential: verified against publicUrl,
    // not the address this client actually sends the request to.
    const htu = `${this.publicUrl}${path}`
    signal?.throwIfAborted()
    const presentationProof = await credentialProof.createPresentationProof(
      'GET',
      htu,
    )
    signal?.throwIfAborted()
    const res = await this.fetchImpl(url, {
      method: 'GET',
      signal: requestSignal(this.requestTimeoutMs, signal),
      headers: {
        accept: 'application/json',
        authorization: `DPoP ${credentialProof.credential}`,
        dpop: presentationProof,
      },
    })
    await throwIfNotOk(res, url.toString(), lxm)
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err
      throw new StratosInvalidResponseError(
        url.toString(),
        lxm,
        'body was not valid JSON',
        { cause: err },
      )
    }
    return decodeListSpaceRepos(body, url.toString(), lxm)
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

function requestSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return caller ? AbortSignal.any([caller, timeout]) : timeout
}

function decodeListSpaceRepos(
  raw: unknown,
  url: string,
  lxm: string,
): ListSpaceReposResult {
  if (!isRecord(raw) || !Array.isArray(raw.repos)) {
    throw new StratosInvalidResponseError(url, lxm, 'repos was not an array')
  }
  const repos = raw.repos.map((entry, index) =>
    decodeSpaceRepoEntry(entry, index, url, lxm),
  )
  if (raw.cursor !== undefined && typeof raw.cursor !== 'string') {
    throw new StratosInvalidResponseError(url, lxm, 'cursor was not a string')
  }
  return {
    repos,
    ...(raw.cursor !== undefined ? { cursor: raw.cursor } : {}),
  }
}

function decodeSpaceRepoEntry(
  raw: unknown,
  index: number,
  url: string,
  lxm: string,
): SpaceRepoEntry {
  if (!isRecord(raw)) {
    throw new StratosInvalidResponseError(
      url,
      lxm,
      `repo at index ${index} was not an object`,
    )
  }
  if (typeof raw.did !== 'string') {
    throw new StratosInvalidResponseError(
      url,
      lxm,
      `repo at index ${index} had no DID`,
    )
  }
  if (raw.rev !== undefined && typeof raw.rev !== 'string') {
    throw new StratosInvalidResponseError(
      url,
      lxm,
      `repo at index ${index} had an invalid rev`,
    )
  }
  if (raw.host !== undefined && typeof raw.host !== 'string') {
    throw new StratosInvalidResponseError(
      url,
      lxm,
      `repo at index ${index} had an invalid host`,
    )
  }
  if (
    raw.hostSource !== undefined &&
    raw.hostSource !== 'authority-override' &&
    raw.hostSource !== 'did-document'
  ) {
    throw new StratosInvalidResponseError(
      url,
      lxm,
      `repo at index ${index} had an invalid host source`,
    )
  }
  return {
    did: raw.did,
    custody: raw.custody === 'pds' ? 'pds' : 'stratos',
    ...(raw.rev !== undefined ? { rev: raw.rev } : {}),
    ...(raw.host !== undefined ? { host: raw.host } : {}),
    ...(raw.hostSource !== undefined ? { hostSource: raw.hostSource } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
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

import { parseDidKey, verifySignature } from '@atproto/crypto'
import type { DidResolver } from '@atproto/identity'
import { expand as hkdfExpand } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { timingSafeEqual } from 'node:crypto'

/**
 * Wire version this verifier accepts. Matches `COMMIT_VERSION` in
 * `packages/space/src/repo-commit.ts` at the pinned upstream commit (see
 * `encodeCommitCtx` below).
 */
const COMMIT_VERSION = 1

export interface CommitVerifierDeps {
  didResolver: Pick<DidResolver, 'resolveAtprotoKey'>
}

export type CommitVerifyFailureReason =
  | 'missing-commit'
  | 'malformed-commit'
  | 'unsupported-version'
  | 'key-unresolvable'
  | 'mac-mismatch'
  | 'signature-invalid'

export interface CommitVerifySuccess {
  readonly ok: true
}

export interface CommitVerifyFailure {
  readonly ok: false
  readonly reason: CommitVerifyFailureReason
  /**
   * `true` when the failure is a DID-resolution hiccup (network, registry
   * outage) rather than a cryptographic finding. The caller must not treat a
   * transient failure as evidence of a hostile host: no purge, no halt, just
   * a skip of this pass.
   */
  readonly transient: boolean
  readonly error?: unknown
}

export type CommitVerifyResult = CommitVerifySuccess | CommitVerifyFailure

/**
 * Verifies a space host's signed final-page commit.
 *
 * Threat model — what this DOES defend:
 * - Transit tampering: a MITM cannot alter `hash`, `rev`, or the op stream's
 *   endpoint without invalidating the signature or MAC.
 * - Third-party tampering: a host cannot be fed a forged commit by anyone
 *   other than the member's own signing key holder.
 * - Cross-space confusion: a host cannot serve one space's commit for
 *   another, because `space` is bound into the signed context.
 *
 * What this does NOT defend (documented, not silently assumed):
 * 1. For a `did:plc` member, the member's PDS host typically custodies the
 *    member's signing key. A malicious PDS can sign whatever it likes with
 *    that key. This check has full adversarial value only against a host
 *    that does NOT also custody the member's key — e.g. a `did:web` member
 *    who self-hosts their key material separately from their repo host.
 * 2. `sig` covers the commit context (`space`, `author`, `rev`, `ikm`), not
 *    the op stream itself. A host that holds a valid commit for revision R
 *    can still serve any op payload it likes for the page(s) leading to R;
 *    this check authenticates the repo's head state, not its history.
 * 3. `hash` is the digest of an LtHash state this feedgen cannot recompute
 *    (it would require the member's full CID set). Verification confirms
 *    `hash` was not altered in transit and was produced by the member's key
 *    for this `rev` — not that `hash` is the correct hash of the member's
 *    actual repo contents.
 */
export class CommitVerifier {
  private readonly didResolver: CommitVerifierDeps['didResolver']

  constructor(deps: CommitVerifierDeps) {
    this.didResolver = deps.didResolver
  }

  async verify(
    spaceUri: string,
    authorDid: string,
    commit: Record<string, unknown> | undefined,
  ): Promise<CommitVerifyResult> {
    if (commit === undefined) {
      return { ok: false, reason: 'missing-commit', transient: false }
    }

    const decoded = decodeSignedCommit(commit)
    if (decoded === undefined) {
      return { ok: false, reason: 'malformed-commit', transient: false }
    }
    if (decoded.ver !== COMMIT_VERSION) {
      return { ok: false, reason: 'unsupported-version', transient: false }
    }

    const resolvedKey = await this.resolveKey(authorDid, false)
    if (!resolvedKey.ok) return resolvedKey

    // Upstream's `verifyCommit` also checks `commit.rev !== ctx.rev` against
    // an independently-tracked expected revision. This poller has no such
    // oracle — `rev` only ever comes from the commit itself — so that check
    // would always compare a value to itself. Tampering with `rev` is still
    // caught below: it is signed as part of `ctxBytes`.
    //
    // `rev` and `ikm` are host-controlled and unbounded in size; `encodeCommitCtx`
    // throws rather than silently truncate a length prefix, so a host cannot
    // hide a field-size overflow. Catching that here keeps `verify` itself in
    // line with the rest of this module: a bad commit is a result, not a throw.
    let ctxBytes: Uint8Array
    try {
      ctxBytes = encodeCommitCtx(
        { space: spaceUri, author: authorDid, rev: decoded.rev },
        decoded.ikm,
      )
    } catch {
      return { ok: false, reason: 'malformed-commit', transient: false }
    }

    const mac = computeMac(decoded.ikm, ctxBytes, decoded.hash)
    if (!timingSafeEqualBytes(mac, decoded.mac)) {
      return { ok: false, reason: 'mac-mismatch', transient: false }
    }

    const validSig = await verifyCommitSignature(
      resolvedKey.didKey,
      ctxBytes,
      decoded.sig,
    )
    if (validSig === undefined) {
      return { ok: false, reason: 'signature-invalid', transient: false }
    }
    if (validSig) return { ok: true }

    // A validly-shaped signature can mismatch after a DID-key rotation when
    // the resolver still holds the previous document. Refresh exactly once
    // before treating the mismatch as cryptographic evidence. Malformed
    // signatures throw above and deliberately never reach this network call.
    const refreshedKey = await this.resolveKey(authorDid, true)
    if (!refreshedKey.ok) return refreshedKey

    const validRefreshedSig = await verifyCommitSignature(
      refreshedKey.didKey,
      ctxBytes,
      decoded.sig,
    )
    if (!validRefreshedSig) {
      return { ok: false, reason: 'signature-invalid', transient: false }
    }

    return { ok: true }
  }

  private async resolveKey(
    authorDid: string,
    forceRefresh: boolean,
  ): Promise<ResolvedCommitKey | CommitVerifyFailure> {
    let didKey: string
    try {
      didKey = await this.didResolver.resolveAtprotoKey(authorDid, forceRefresh)
    } catch (error) {
      return {
        ok: false,
        reason: 'key-unresolvable',
        transient: isTransientResolutionError(error),
        error,
      }
    }

    try {
      parseDidKey(didKey)
    } catch {
      return { ok: false, reason: 'key-unresolvable', transient: false }
    }
    return { ok: true, didKey }
  }
}

interface ResolvedCommitKey {
  readonly ok: true
  readonly didKey: string
}

interface CommitCtx {
  space: string
  author: string
  rev: string
}

interface SignedCommit {
  ver: number
  hash: Uint8Array
  ikm: Uint8Array
  mac: Uint8Array
  sig: Uint8Array
  rev: string
}

/**
 * `hmacSha256`/`hkdfSha256` ported from `packages/crypto/src/hmac.ts:5-11`
 * at upstream `permissioned-data@89deb9faca20e56fa2a262fe9746ed52bc1095ba`.
 * That file is not yet published in the `@atproto/crypto` version this
 * workspace pins, so this reproduces it directly against `@noble/hashes`,
 * the same underlying library `@atproto/crypto` itself uses for this. HKDF
 * here is expand-only (no extract step) because `ikm` already arrives as 32
 * bytes of fresh randomness generated per-commit — using it directly as the
 * PRK is the upstream design, not a shortcut taken here.
 */
function hkdfSha256(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdfExpand(sha256, ikm, info, 32)
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data)
}

/**
 * Ported from `computeMac` in `packages/space/src/repo-commit.ts:119-125`
 * at upstream `permissioned-data@89deb9faca20e56fa2a262fe9746ed52bc1095ba`.
 */
function computeMac(
  ikm: Uint8Array,
  ctxBytes: Uint8Array,
  hash: Uint8Array,
): Uint8Array {
  return hmacSha256(hkdfSha256(ikm, ctxBytes), hash)
}

const DOMAIN_PREFIX = new TextEncoder().encode('atproto-space-v1')

/**
 * Ported byte-for-byte from `encodeCommitCtx` in
 * `packages/space/src/repo-commit.ts:141-171` at upstream
 * `permissioned-data@89deb9faca20e56fa2a262fe9746ed52bc1095ba`:
 * `"atproto-space-v1" || uint16be(len(space))||space ||
 * uint16be(len(author))||author || uint16be(len(rev))||rev ||
 * uint16be(len(ikm))||ikm`, all length prefixes big-endian.
 */
function encodeCommitCtx(ctx: CommitCtx, ikm: Uint8Array): Uint8Array {
  const encoder = new TextEncoder()
  const fields = [
    encoder.encode(ctx.space),
    encoder.encode(ctx.author),
    encoder.encode(ctx.rev),
    ikm,
  ]
  let size = DOMAIN_PREFIX.length
  for (const field of fields) {
    if (field.length > 0xffff) {
      throw new Error('commit ctx field exceeds uint16 length prefix')
    }
    size += 2 + field.length
  }
  const out = new Uint8Array(size)
  out.set(DOMAIN_PREFIX)
  let offset = DOMAIN_PREFIX.length
  for (const field of fields) {
    out[offset++] = (field.length >>> 8) & 0xff
    out[offset++] = field.length & 0xff
    out.set(field, offset)
    offset += field.length
  }
  return out
}

// `timingSafeEqual` throws on a length mismatch instead of returning false,
// so the equal-length check must run first.
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function verifyCommitSignature(
  didKey: string,
  ctxBytes: Uint8Array,
  signature: Uint8Array,
): Promise<boolean | undefined> {
  try {
    return await verifySignature(didKey, ctxBytes, signature)
  } catch {
    return undefined
  }
}

function decodeSignedCommit(
  commit: Record<string, unknown>,
): SignedCommit | undefined {
  const ver = commit.ver
  const rev = commit.rev
  const hash = decodeLexBytes(commit.hash)
  const ikm = decodeLexBytes(commit.ikm)
  const mac = decodeLexBytes(commit.mac)
  const sig = decodeLexBytes(commit.sig)
  if (
    typeof ver !== 'number' ||
    typeof rev !== 'string' ||
    hash === undefined ||
    ikm === undefined ||
    mac === undefined ||
    sig === undefined
  ) {
    return undefined
  }
  return { ver, rev, hash, ikm, mac, sig }
}

/**
 * Decodes AT Protocol's lexicon-JSON bytes convention (`{"$bytes": "..."}`,
 * standard base64) as it arrives over the XRPC/JSON wire. Hand-rolled rather
 * than pulled from `@atproto/lex-data`/`@atproto/lex-json`: neither is a
 * dependency reachable from this package, and the convention is this small.
 */
function decodeLexBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  // `Buffer.from(str, 'base64')` never throws for a string input — it
  // decodes best-effort — so there is no failure case left to guard once
  // the string check above has run.
  if (typeof record.$bytes !== 'string') return undefined
  return Buffer.from(record.$bytes, 'base64')
}

const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

/**
 * Resolution failures are permanent unless they carry a known retryable
 * shape. The pinned resolver collapses did:web non-2xx responses to
 * `DidNotFoundError`, so this seam deliberately fails those closed too.
 */
function isTransientResolutionError(error: unknown): boolean {
  const pending = [error]
  const seen = new Set<unknown>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      continue
    }
    seen.add(current)
    const record = current as Record<string, unknown>
    if (isRetryableResolutionError(record)) return true
    if (record.cause !== undefined) pending.push(record.cause)
    if (Array.isArray(record.errors)) {
      const nestedErrors: readonly unknown[] = record.errors
      for (const nestedError of nestedErrors) pending.push(nestedError)
    }
  }
  return false
}

function isRetryableResolutionError(record: Record<string, unknown>): boolean {
  return (
    hasTransientErrorName(record.name) ||
    hasRetryableHttpStatus(record.status) ||
    hasTransientNetworkCode(record.code) ||
    isFetchFailure(record)
  )
}

function hasTransientErrorName(name: unknown): boolean {
  return (
    name === 'AbortError' || name === 'TimeoutError' || name === 'NetworkError'
  )
}

function hasRetryableHttpStatus(status: unknown): boolean {
  if (typeof status !== 'number') return false
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function hasTransientNetworkCode(code: unknown): boolean {
  return typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)
}

function isFetchFailure(record: Record<string, unknown>): boolean {
  if (record.name !== 'TypeError') return false
  if (typeof record.message !== 'string') return false
  return isFetchFailureMessage(record.message)
}

function isFetchFailureMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase()
  return (
    normalized === 'fetch failed' ||
    normalized === 'failed to fetch' ||
    normalized === 'networkerror when attempting to fetch resource.'
  )
}

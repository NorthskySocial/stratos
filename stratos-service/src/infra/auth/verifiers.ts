import { timingSafeEqual } from 'node:crypto'
import { IdResolver } from '@atproto/identity'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import {
  AuthRequiredError,
  InvalidRequestError,
  type StreamAuthVerifier,
} from '@atproto/xrpc-server'
import { verifyServiceAuth } from './verifier.js'
import { DpopVerificationError, DpopVerifier } from './index.js'
import {
  SPACE_CREDENTIAL_TYP,
  SpaceCredentialVerificationError,
  verifySpaceCredential,
} from './space-credential-verifier.js'
import {
  EnrollmentDeniedError,
  type Logger,
} from '@northskysocial/stratos-core'
import type { Keypair } from '@atproto/crypto'
import { StratosServiceConfig } from '../../config.js'
import { ExternalAllowListProvider } from '../../features/enrollment/internal/allow-list.js'
import { verifyEnrolled } from '../../features'

/**
 * Auth verifier collection for different auth scenarios
 */
export interface AuthVerifiers {
  /** Standard user auth (OAuth token) */
  standard: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{ credentials: { type: string; did: string } }>
  /** Service-to-service auth (inter-service JWT) */
  service: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{ credentials: { type: string; did: string; iss: string } }>
  /** Optional user auth */
  optionalStandard: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{ credentials: { type: string; did?: string } }>
  /**
   * Space-credential auth: a multi-use JWT this service minted for a
   * single space, verified against our OWN signing key (no DID resolution).
   * Yields the admitted space URI; the caller has no `did`.
   */
  spaceCredential: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{ credentials: { type: 'space-credential'; spaceUri: string } }>
  /**
   * Composition of {@link standard} and {@link spaceCredential}. A
   * DPoP session yields `{ type: 'user', did }`; a space credential (a Bearer
   * JWT whose `typ` is a space credential) yields
   * `{ type: 'space-credential', spaceUri }`. Anything else is rejected. This
   * is bound to read/sync endpoints ONLY; writes never accept a credential.
   */
  standardOrSpaceCredential: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{
    credentials:
      | { type: string; did: string }
      | { type: 'space-credential'; spaceUri: string }
  }>
  /**
   * Composition of {@link optionalStandard} and {@link spaceCredential}.
   * Used for read endpoints that were previously anonymous-friendly
   * (the hydration surface): an anonymous request stays anonymous (behaviour
   * unchanged), a DPoP session yields a user, and a space-credential Bearer JWT
   * yields `{ type: 'space-credential', spaceUri }`.
   */
  optionalStandardOrSpaceCredential: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{
    credentials:
      | { type: string; did?: string }
      | { type: 'space-credential'; spaceUri: string }
  }>
  /**
   * Composition of {@link service} and {@link spaceCredential} for the
   * pull-sync read endpoints. A space-credential Bearer JWT yields
   * `{ type: 'space-credential', spaceUri }`; any other Bearer is verified as
   * inter-service auth and behaves EXACTLY as before.
   */
  serviceOrSpaceCredential: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{
    credentials:
      | { type: string; did: string; iss: string }
      | { type: 'space-credential'; spaceUri: string }
  }>
  /** Admin auth (basic auth or bearer token with admin password) */
  admin: (ctx: {
    req: import('node:http').IncomingMessage
    res: import('node:http').ServerResponse
  }) => Promise<{ credentials: { type: string } }>
  /** Stream auth for zone.stratos.sync.subscribeRecords */
  subscribeAuth: StreamAuthVerifier
}

/**
 * Timing-safe string comparison to prevent timing attacks on credentials
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    // Compare against self to consume constant time, then return false
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/**
 * Create auth verifiers for the application
 * @param serviceDid - Service DID
 * @param idResolver - Identity resolver
 * @param _oauthClient - OAuth client
 * @param cfg
 * @param enrollmentStore - Enrollment store
 * @param adminPassword - Admin password
 * @param dpopVerifier - DPoP verifier
 * @param allowListProvider - External allowlist provider
 * @param devMode - Development mode flag
 * @param signingKey - This service's signing keypair (space-credential authority)
 * @param logger
 * @returns Auth verifiers object
 */
export function createAuthVerifiers(
  serviceDid: string,
  idResolver: IdResolver,
  _oauthClient: NodeOAuthClient,
  cfg: StratosServiceConfig,
  enrollmentStore: import('@northskysocial/stratos-core').EnrollmentStoreReader,
  adminPassword: string | undefined,
  dpopVerifier: DpopVerifier,
  allowListProvider: ExternalAllowListProvider | undefined,
  devMode: boolean,
  signingKey: Pick<Keypair, 'did'>,
  logger?: Logger,
): AuthVerifiers {
  const standard = createStandardVerifier({
    devMode,
    idResolver,
    cfg,
    enrollmentStore,
    allowListProvider,
    dpopVerifier,
    logger,
  })
  const spaceCredential = createSpaceCredentialVerifier({
    serviceDid,
    signingKey,
    logger,
  })
  const service = createServiceVerifier({ serviceDid, idResolver })
  const optionalStandard = createOptionalStandardVerifier({
    devMode,
    idResolver,
    cfg,
    enrollmentStore,
    allowListProvider,
    dpopVerifier,
    logger,
  })
  return {
    standard,
    service,
    optionalStandard,
    spaceCredential,
    standardOrSpaceCredential: withSpaceCredentialFallback(
      standard,
      spaceCredential,
    ),
    optionalStandardOrSpaceCredential: withSpaceCredentialFallback(
      optionalStandard,
      spaceCredential,
    ),
    serviceOrSpaceCredential: withSpaceCredentialFallback(
      service,
      spaceCredential,
    ),
    admin: createAdminVerifier(adminPassword),
    subscribeAuth: createSubscribeAuthVerifier(idResolver, serviceDid),
  }
}

/**
 * Creates the standard user auth verifier (OAuth token)
 *
 * @param deps - Dependencies for the verifier
 * @returns Auth verifier function
 */
type StandardVerifierDeps = {
  devMode: boolean
  idResolver: IdResolver
  cfg: StratosServiceConfig
  enrollmentStore: import('@northskysocial/stratos-core').EnrollmentStoreReader
  allowListProvider: ExternalAllowListProvider | undefined
  dpopVerifier: DpopVerifier
  logger?: Logger
}

async function handleDevModeAuth(
  authHeader: string,
  deps: StandardVerifierDeps,
): Promise<{ credentials: { type: string; did: string } }> {
  const did = authHeader.slice(7).trim()
  if (did.startsWith('did:')) {
    await verifyEnrolled(did, {
      idResolver: deps.idResolver,
      enrollmentStore: deps.enrollmentStore,
      config: deps.cfg.enrollment,
      allowListProvider: deps.allowListProvider,
      logger: deps.logger,
    })
    return { credentials: { type: 'user', did } }
  }
  deps.logger?.info('auth rejected: dev bearer token is not a DID')
  throw new AuthRequiredError('Authorization failed')
}

async function verifyDpopAuth(
  ctx: Parameters<AuthVerifiers['standard']>[0],
  deps: StandardVerifierDeps,
): Promise<{ credentials: { type: string; did: string } }> {
  try {
    const result = await deps.dpopVerifier.verify(
      {
        method: ctx.req.method || 'GET',
        url: ctx.req.url || '/',
        headers: ctx.req.headers as Record<
          string,
          string | string[] | undefined
        >,
      },
      { setHeader: (name, value) => ctx.res?.setHeader(name, value) },
    )

    await verifyEnrolled(result.did, {
      idResolver: deps.idResolver,
      enrollmentStore: deps.enrollmentStore,
      config: deps.cfg.enrollment,
      allowListProvider: deps.allowListProvider,
      logger: deps.logger,
    })

    return { credentials: { type: 'user', did: result.did } }
  } catch (err) {
    if (err instanceof DpopVerificationError && err.code === 'use_dpop_nonce') {
      const nonce = deps.dpopVerifier.nextNonce()
      if (nonce) ctx.res?.setHeader('DPoP-Nonce', nonce)
    }
    handleDpopError(ctx, err, deps.logger)
  }
}

function createStandardVerifier(
  deps: StandardVerifierDeps,
): AuthVerifiers['standard'] {
  return async (ctx) => {
    const authHeader = ctx.req?.headers?.authorization
    if (!authHeader) {
      deps.logger?.info(
        { path: ctx.req?.url, method: ctx.req?.method },
        'auth rejected: no authorization header',
      )
      throw new AuthRequiredError('Authorization required')
    }

    if (deps.devMode && authHeader.startsWith('Bearer ')) {
      return handleDevModeAuth(authHeader, deps)
    }

    if (!authHeader.startsWith('DPoP ') || !deps.dpopVerifier) {
      deps.logger?.info(
        { path: ctx.req?.url, scheme: authHeader.split(' ')[0] },
        'auth rejected: expected DPoP scheme',
      )
      throw new AuthRequiredError('DPoP authorization required')
    }

    return verifyDpopAuth(ctx, deps)
  }
}

/**
 * Creates the service-to-service auth verifier (inter-service JWT)
 *
 * @param deps - Dependencies for service-to-service verification
 * @returns Auth verifier function
 * @throws AuthRequiredError if service authorization fails
 */
function createServiceVerifier(deps: {
  serviceDid: string
  idResolver: IdResolver
}): AuthVerifiers['service'] {
  return async (ctx) => {
    const authHeader = ctx.req?.headers?.authorization
    if (!authHeader) {
      throw new AuthRequiredError('Service authorization required')
    }

    try {
      const result = await verifyServiceAuth(
        authHeader,
        deps.serviceDid,
        undefined, // expectedLxm
        deps.idResolver,
      )
      return {
        credentials: { type: 'service', did: result.iss, iss: result.iss },
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Service authorization failed'
      throw new AuthRequiredError(message)
    }
  }
}

/**
 * Extract a `Bearer` token whose JWT `typ` header is a space credential, or
 * `null` if the header is absent, not `Bearer`, or the token is not a
 * space-credential JWT. Only a cheap header peek — full verification (signature,
 * `exp`, `sub`) happens in {@link verifySpaceCredential}.
 *
 * @param authHeader - The raw Authorization header value.
 * @returns The bearer token when it looks like a space credential, else null.
 */
function extractSpaceCredentialToken(
  authHeader: string | undefined,
): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString(),
    ) as {
      typ?: string
    }
    return header?.typ === SPACE_CREDENTIAL_TYP ? token : null
  } catch {
    return null
  }
}

/**
 * Creates the space-credential auth verifier.
 *
 * Accepts a `Bearer` JWT whose `typ` is a space credential, verifies it against
 * OUR OWN signing key (no DID resolution), and yields the admitted space URI.
 * The caller has no `did`; downstream scope enforcement maps the space to its
 * boundary and injects a singleton viewer-boundary set so the existing
 * per-record gate still applies.
 *
 * @param deps - Service DID, our signing key, and an optional logger.
 * @returns Auth verifier function.
 * @throws AuthRequiredError if the header is missing / not a space credential,
 *   or the credential fails verification.
 */
function createSpaceCredentialVerifier(deps: {
  serviceDid: string
  signingKey: Pick<Keypair, 'did'>
  logger?: Logger
}): AuthVerifiers['spaceCredential'] {
  return async (ctx) => {
    const authHeader = ctx.req?.headers?.authorization
    const token = extractSpaceCredentialToken(authHeader)
    if (!token) {
      throw new AuthRequiredError('Space credential required')
    }
    try {
      const result = await verifySpaceCredential(token, {
        serviceKey: deps.signingKey,
        serviceDid: deps.serviceDid,
      })
      return {
        credentials: {
          type: 'space-credential' as const,
          spaceUri: result.spaceUri,
        },
      }
    } catch (err) {
      if (err instanceof SpaceCredentialVerificationError) {
        deps.logger?.info(
          { reason: err.name, message: err.message, path: ctx.req?.url },
          'auth rejected: space credential verification failed',
        )
        throw new AuthRequiredError(err.message)
      }
      throw err
    }
  }
}

/**
 * Composes a space-credential verifier with a base verifier. Routing is
 * by JWT `typ`: a `Bearer` whose `typ` is a space credential takes the
 * space-credential path; anything else (no header, DPoP, dev `Bearer did:...`,
 * or inter-service `Bearer`) falls through to `fallback`, which behaves EXACTLY
 * as before. Bound to read/sync endpoints ONLY; write endpoints keep `standard`.
 *
 * @param fallback - The base verifier used when the token is not a space credential.
 * @param spaceCredential - The space-credential verifier.
 * @returns A verifier yielding either the fallback's or the credential's result.
 */
function withSpaceCredentialFallback<R>(
  fallback: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<R>,
  spaceCredential: AuthVerifiers['spaceCredential'],
): (
  ctx: import('@atproto/xrpc-server').MethodAuthContext,
) => Promise<R | Awaited<ReturnType<AuthVerifiers['spaceCredential']>>> {
  return async (ctx) => {
    const authHeader = ctx.req?.headers?.authorization
    if (extractSpaceCredentialToken(authHeader)) {
      return spaceCredential(ctx)
    }
    return fallback(ctx)
  }
}

/**
 * Creates the optional user auth verifier
 *
 * @param deps - Dependencies for optional user verification
 * @returns Auth verifier function
 */
function createOptionalStandardVerifier(deps: {
  devMode: boolean
  idResolver: IdResolver
  cfg: StratosServiceConfig
  enrollmentStore: import('@northskysocial/stratos-core').EnrollmentStoreReader
  allowListProvider: ExternalAllowListProvider | undefined
  dpopVerifier: DpopVerifier
  logger?: Logger
}): AuthVerifiers['optionalStandard'] {
  return async (ctx) => {
    const authHeader = ctx.req?.headers?.authorization
    if (!authHeader) {
      return { credentials: { type: 'anonymous' } }
    }

    if (deps.devMode && authHeader.startsWith('Bearer ')) {
      return await verifyDevBearer(authHeader, deps)
    }

    if (!authHeader.startsWith('DPoP ') || !deps.dpopVerifier) {
      return { credentials: { type: 'anonymous' } }
    }

    const result = await verifyDpop(ctx, deps.dpopVerifier)
    if (result.credentials.type === 'user' && result.credentials.did) {
      try {
        await verifyEnrolled(result.credentials.did, {
          idResolver: deps.idResolver,
          enrollmentStore: deps.enrollmentStore,
          config: deps.cfg.enrollment,
          allowListProvider: deps.allowListProvider,
          logger: deps.logger,
        })
      } catch {
        return { credentials: { type: 'anonymous' } }
      }
    }
    return result
  }
}

/**
 * Verifies a bearer token for development purposes
 *
 * @param authHeader - Authorization header containing bearer token
 * @param deps - Dependencies for development bearer verification
 * @returns Authentication result with user credentials or anonymous
 */
async function verifyDevBearer(
  authHeader: string,
  deps: {
    idResolver: IdResolver
    cfg: StratosServiceConfig
    enrollmentStore: import('@northskysocial/stratos-core').EnrollmentStoreReader
    allowListProvider: ExternalAllowListProvider | undefined
    logger?: Logger
  },
): Promise<{
  credentials: { type: 'user'; did: string } | { type: 'anonymous' }
}> {
  const did = authHeader.slice(7).trim()
  if (did.startsWith('did:')) {
    try {
      await verifyEnrolled(did, {
        idResolver: deps.idResolver,
        enrollmentStore: deps.enrollmentStore,
        config: deps.cfg.enrollment,
        allowListProvider: deps.allowListProvider,
        logger: deps.logger,
      })
      return { credentials: { type: 'user', did } }
    } catch {
      // ignore
    }
  }
  return { credentials: { type: 'anonymous' } }
}

/**
 * Verifies a DPoP token for authenticated requests
 *
 * @param ctx - Request context
 * @param dpopVerifier - DPoP verifier function
 * @returns Authentication result with user credentials or anonymous
 */
async function verifyDpop(
  ctx: {
    req: {
      method?: string
      url?: string
      headers: Record<string, string | string[] | undefined>
    }
    res?: { setHeader(name: string, value: string | string[]): void }
  },
  dpopVerifier: DpopVerifier,
): Promise<{
  credentials: { type: 'user'; did: string } | { type: 'anonymous' }
}> {
  try {
    const result = await dpopVerifier.verify(
      {
        method: ctx.req.method || 'GET',
        url: ctx.req.url || '/',
        headers: ctx.req.headers,
      },
      {
        setHeader: (name, value) => ctx.res?.setHeader(name, value),
      },
    )
    return {
      credentials: { type: 'user', did: result.did },
    }
  } catch (err) {
    if (err instanceof DpopVerificationError) {
      if (err.nonce) {
        ctx.res?.setHeader('DPoP-Nonce', err.nonce)
      }
      if (err.wwwAuthenticate) {
        ctx.res?.setHeader('WWW-Authenticate', err.wwwAuthenticate)
      }
    }
    return { credentials: { type: 'anonymous' } }
  }
}

/**
 * Creates the admin auth verifier (basic auth or bearer token)
 *
 * @param adminPassword - Admin password for basic auth
 * @returns Auth verifier function
 * @throws AuthRequiredError if admin authorization fails
 */
function createAdminVerifier(
  adminPassword: string | undefined,
): AuthVerifiers['admin'] {
  return async (ctx) => {
    const authHeader = ctx.req?.headers?.authorization
    if (!authHeader || !adminPassword) {
      throw new AuthRequiredError('Admin authorization required')
    }

    let passwordAttempt: string | undefined
    if (authHeader.startsWith('Basic ')) {
      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString(
        'utf8',
      )
      const parts = credentials.split(':')
      passwordAttempt = parts[1]
    } else if (authHeader.startsWith('Bearer ')) {
      passwordAttempt = authHeader.slice(7).trim()
    }

    if (passwordAttempt && safeEqual(passwordAttempt, adminPassword)) {
      return { credentials: { type: 'admin' } }
    }

    throw new AuthRequiredError('Invalid admin credentials')
  }
}

/**
 * Creates the stream auth verifier for sync subscriptions.
 *
 * Only inter-service auth JWTs (Authorization: Bearer) are accepted. The master
 * sync token, query-parameter tokens, and anonymous access have been removed.
 *
 * @param idResolver - Identity resolver
 * @param ourDid - Our service DID
 * @returns Auth verifier function
 * @throws AuthRequiredError if the service-auth JWT is missing or invalid
 */
export function createSubscribeAuthVerifier(
  idResolver: IdResolver,
  ourDid: string,
): AuthVerifiers['subscribeAuth'] {
  return async (ctx) => {
    const authHeader = ctx.req?.headers?.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AuthRequiredError('Service authorization required')
    }

    try {
      const result = await verifyServiceAuth(
        authHeader,
        ourDid,
        'zone.stratos.sync.subscribeRecords',
        idResolver,
      )
      return {
        credentials: { type: 'service', did: result.iss, iss: result.iss },
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Service authorization failed'
      throw new AuthRequiredError(message)
    }
  }
}

/**
 * Shared logic to handle DPoP errors in standard auth
 * @param ctx - XRPC context
 * @param err - Error object
 * @param logger - Logger instance
 * @throws AuthRequiredError - If DPoP verification fails
 * @throws InvalidRequestError - If user is not enrolled
 */
function handleDpopError(
  ctx: import('@atproto/xrpc-server').MethodAuthContext,
  err: unknown,
  logger?: Logger,
): never {
  if (err instanceof DpopVerificationError) {
    logger?.info(
      {
        code: err.code,
        message: err.message,
        path: ctx.req?.url,
      },
      `auth rejected: DPoP verification failed (${err.code})`,
    )
    if (err.nonce) {
      ctx.res?.setHeader('DPoP-Nonce', err.nonce)
    }
    if (err.wwwAuthenticate) {
      ctx.res?.setHeader('WWW-Authenticate', err.wwwAuthenticate)
    }
    if (err.code === 'use_dpop_nonce') {
      throw new AuthRequiredError(err.message, 'AuthenticationRequired')
    }
  }

  if (
    (err instanceof DpopVerificationError && err.code === 'not_enrolled') ||
    err instanceof EnrollmentDeniedError
  ) {
    throw new InvalidRequestError(
      'User is not enrolled in this Stratos service',
      'NotEnrolled',
    )
  }

  const message =
    err instanceof Error ? err.message : 'DPoP verification failed'
  throw new AuthRequiredError(message)
}

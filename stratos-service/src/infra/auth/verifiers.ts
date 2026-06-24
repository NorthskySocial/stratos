import { IdResolver } from '@atproto/identity'
import {
  AuthRequiredError,
  InvalidRequestError,
  type StreamAuthVerifier,
} from '@atproto/xrpc-server'
import { verifyServiceAuth } from './verifier.js'
import { DpopVerificationError, DpopVerifier } from './index.js'
import {
  EnrollmentDeniedError,
  type Logger,
} from '@northskysocial/stratos-core'
import {
  isAllowedCredentialedOrigin,
  StratosServiceConfig,
} from '../../config.js'
import { ExternalAllowListProvider } from '../../features/enrollment/internal/allow-list.js'
import { verifyEnrolled } from '../../features'
import { ADMIN_SESSION_COOKIE } from '../../oauth/admin-routes.js'
import type { AdminSessionStore } from '../../oauth/admin-session-store.js'

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
  /** Admin auth (OAuth-authorized operator via server-side session cookie) */
  admin: (ctx: {
    req: import('node:http').IncomingMessage
    res: import('node:http').ServerResponse
  }) => Promise<{ credentials: { type: string; did: string } }>
  /** Stream auth for zone.stratos.sync.subscribeRecords */
  subscribeAuth: StreamAuthVerifier
}

/**
 * Create auth verifiers for the application
 * @param serviceDid - Service DID
 * @param idResolver - Identity resolver
 * @param cfg
 * @param enrollmentStore - Enrollment store
 * @param adminSessionStore - Admin web-session store
 * @param adminDids - Allowlisted admin DIDs
 * @param dpopVerifier - DPoP verifier
 * @param allowListProvider - External allowlist provider
 * @param devMode - Development mode flag
 * @param logger
 * @returns Auth verifiers object
 */
export function createAuthVerifiers(
  serviceDid: string,
  idResolver: IdResolver,
  cfg: StratosServiceConfig,
  enrollmentStore: import('@northskysocial/stratos-core').EnrollmentStoreReader,
  adminSessionStore: AdminSessionStore,
  adminDids: string[],
  dpopVerifier: DpopVerifier,
  allowListProvider: ExternalAllowListProvider | undefined,
  devMode: boolean,
  logger?: Logger,
): AuthVerifiers {
  return {
    standard: createStandardVerifier({
      devMode,
      idResolver,
      cfg,
      enrollmentStore,
      allowListProvider,
      dpopVerifier,
      logger,
    }),
    service: createServiceVerifier({ serviceDid, idResolver }),
    optionalStandard: createOptionalStandardVerifier({
      devMode,
      idResolver,
      cfg,
      enrollmentStore,
      allowListProvider,
      dpopVerifier,
      logger,
    }),
    admin: createAdminVerifier({
      adminSessionStore,
      adminDids,
      publicUrl: cfg.service.publicUrl,
      devMode,
      logger,
    }),
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
 * Reads the opaque admin session id from the request's Cookie header.
 *
 * The admin verifier runs at the raw `IncomingMessage` level (no Express
 * cookie parsing), so the cookie is parsed directly here.
 */
function readAdminSessionCookie(
  req: import('node:http').IncomingMessage,
): string | undefined {
  const cookieHeader = req.headers?.cookie
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === ADMIN_SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return undefined
}

/**
 * CSRF defense for cookie-authenticated admin requests.
 *
 * Cookie sessions are CSRF-susceptible in a way Bearer tokens were not, and
 * `SameSite=Lax` does not cover same-site sub-origins or all request shapes.
 * As defense in depth, the request's `Origin` (falling back to `Referer`)
 * must resolve to an allowlisted credentialed origin. Same-origin admin UI
 * requests (plan 004) pass; cross-site forged POSTs do not.
 *
 * Requests with no Origin/Referer at all (e.g. server-to-server tooling that
 * also lacks a browser session cookie) are not blocked here — they simply
 * won't carry the cookie and fail the session check instead.
 *
 * @returns true if the request may proceed past CSRF screening
 */
function passesAdminCsrfCheck(
  req: import('node:http').IncomingMessage,
  deps: { publicUrl: string; devMode: boolean },
): boolean {
  const origin = req.headers?.origin
  if (origin) {
    return isAllowedCredentialedOrigin(origin, deps)
  }

  const referer = req.headers?.referer
  if (referer) {
    try {
      return isAllowedCredentialedOrigin(new URL(referer).origin, deps)
    } catch {
      return false
    }
  }

  // No Origin and no Referer: nothing to forge against. The session-cookie
  // check downstream is the real gate.
  return true
}

/**
 * Creates the admin auth verifier.
 *
 * Admin auth is OAuth-only: the operator must have an established server-side
 * web session (set by the admin OAuth callback) whose DID is on the configured
 * allowlist. There is no password and no `Bearer did:` dev bypass — the cookie
 * is the only accepted credential. A CSRF Origin/Referer check guards the
 * cookie-authenticated mutation path.
 *
 * @param deps - Admin session store, allowlist, origin config, and logger
 * @returns Auth verifier function
 * @throws AuthRequiredError if no valid admin session is present or CSRF fails
 */
function createAdminVerifier(deps: {
  adminSessionStore: AdminSessionStore
  adminDids: string[]
  publicUrl: string
  devMode: boolean
  logger?: Logger
}): AuthVerifiers['admin'] {
  return async (ctx) => {
    if (
      !passesAdminCsrfCheck(ctx.req, {
        publicUrl: deps.publicUrl,
        devMode: deps.devMode,
      })
    ) {
      deps.logger?.warn(
        { origin: ctx.req.headers?.origin },
        'admin auth rejected: cross-origin request blocked (CSRF)',
      )
      throw new AuthRequiredError('Cross-origin admin request rejected')
    }

    const sessionKey = readAdminSessionCookie(ctx.req)
    if (!sessionKey) {
      throw new AuthRequiredError('Admin authorization required')
    }

    const session = await deps.adminSessionStore.get(sessionKey)
    if (!session) {
      throw new AuthRequiredError('Admin session invalid or expired')
    }

    if (!deps.adminDids.includes(session.did)) {
      deps.logger?.warn(
        { did: session.did },
        'admin auth rejected: DID not in allowlist',
      )
      throw new AuthRequiredError('Not an authorized admin')
    }

    return { credentials: { type: 'admin', did: session.did } }
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

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
  EnrollmentDeniedError,
  type Logger,
} from '@northskysocial/stratos-core'
import { StratosServiceConfig } from '../../config.js'
import { ExternalAllowListProvider } from '../../features/enrollment/internal/allow-list.js'
import { verifyEnrolled } from '../../features/index.js'

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
  /** Admin auth (basic auth or bearer token with admin password) */
  admin: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{ credentials: { type: string } }>
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
 * @param syncToken - Sync token
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
  syncToken: string | undefined,
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
    admin: createAdminVerifier(adminPassword),
    subscribeAuth: createSubscribeAuthVerifier(syncToken),
  }
}

/**
 * Creates the standard user auth verifier (OAuth token)
 *
 * @param deps - Dependencies for the verifier
 * @returns Auth verifier function
 */
function createStandardVerifier(deps: {
  devMode: boolean
  idResolver: IdResolver
  cfg: StratosServiceConfig
  enrollmentStore: import('@northskysocial/stratos-core').EnrollmentStoreReader
  allowListProvider: ExternalAllowListProvider | undefined
  dpopVerifier: DpopVerifier
  logger?: Logger
}): AuthVerifiers['standard'] {
  return async (ctx) => {
    const authHeader = ctx.req?.headers?.authorization
    if (!authHeader) {
      throw new AuthRequiredError('Authorization required')
    }

    if (deps.devMode && authHeader.startsWith('Bearer ')) {
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
      throw new AuthRequiredError('Authorization failed')
    }

    if (!authHeader.startsWith('DPoP ') || !deps.dpopVerifier) {
      throw new AuthRequiredError('DPoP authorization required')
    }

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
        {
          setHeader: (name, value) => ctx.res?.setHeader(name, value),
        },
      )

      await verifyEnrolled(result.did, {
        idResolver: deps.idResolver,
        enrollmentStore: deps.enrollmentStore,
        config: deps.cfg.enrollment,
        allowListProvider: deps.allowListProvider,
        logger: deps.logger,
      })

      return {
        credentials: { type: 'user', did: result.did },
      }
    } catch (err) {
      handleDpopError(ctx, err)
    }
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
    if (err instanceof DpopVerificationError && err.wwwAuthenticate) {
      ctx.res?.setHeader('WWW-Authenticate', err.wwwAuthenticate)
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
 * Creates the stream auth verifier for sync subscriptions
 *
 * @param syncToken - Sync token for authenticated subscriptions
 * @returns Auth verifier function
 * @throws AuthRequiredError if sync token is invalid
 */
function createSubscribeAuthVerifier(
  syncToken: string | undefined,
): AuthVerifiers['subscribeAuth'] {
  return async (ctx) => {
    const authHeader = ctx.req?.headers?.authorization
    const query = (ctx.req as { query?: Record<string, unknown> }).query
    const queryToken = query?.token

    if (syncToken) {
      let attempt: string | undefined
      if (authHeader?.startsWith('Bearer ')) {
        attempt = authHeader.slice(7).trim()
      } else if (typeof queryToken === 'string') {
        attempt = queryToken
      }

      if (attempt && safeEqual(attempt, syncToken)) {
        return { credentials: { type: 'sync' } }
      }
    }

    // If no token, allow but check individual actor permissions if needed
    // Actually, standard subscribeRecords allows anyone to connect
    // and we just filter based on what they ask for if needed.
    // But Stratos sync typically requires a token for full access.
    if (syncToken) {
      throw new AuthRequiredError('Invalid sync token')
    }

    return { credentials: { type: 'anonymous' } }
  }
}

/**
 * Shared logic to handle DPoP errors in standard auth
 * @param ctx - XRPC context
 * @param err - Error object
 * @throws AuthRequiredError - If DPoP verification fails
 * @throws InvalidRequestError - If user is not enrolled
 */
function handleDpopError(
  ctx: import('@atproto/xrpc-server').MethodAuthContext,
  err: unknown,
): never {
  if (err instanceof DpopVerificationError && err.wwwAuthenticate) {
    ctx.res?.setHeader('WWW-Authenticate', err.wwwAuthenticate)
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

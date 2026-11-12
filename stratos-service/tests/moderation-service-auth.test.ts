import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { AuthRequiredError, createServiceJwt } from '@atproto/xrpc-server'
import { envToConfig, parseEnv } from '../src/config.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db'
import { SqliteAdminSessionStore } from '../src/oauth/admin-session-store.js'
import { SqliteAdminUserStore } from '../src/oauth/admin-user-store.js'
import {
  createAuthVerifiers,
  createModerationServiceVerifier,
  type AuthVerifiers,
} from '../src/infra/auth/verifiers.js'
import { createTestConfig } from './utils'

const BASE_ENV: Record<string, string> = {
  STRATOS_SERVICE_DID: 'did:web:host',
  STRATOS_PUBLIC_URL: 'https://host.example.com',
  STRATOS_ALLOWED_DOMAINS: 'general,eng,ops',
}

describe('moderation service DID config', () => {
  let saved: NodeJS.ProcessEnv

  beforeEach(() => {
    saved = { ...process.env }
  })
  afterEach(() => {
    process.env = saved
  })

  function configFor(overrides: Record<string, string>) {
    process.env = { ...BASE_ENV, ...overrides } as NodeJS.ProcessEnv
    return envToConfig(parseEnv())
  }

  it('defaults to an empty list when unset', () => {
    expect(configFor({}).moderationServiceDids).toEqual([])
  })

  it('trims whitespace around comma-separated entries', () => {
    const cfg = configFor({
      STRATOS_MODERATION_SERVICE_DIDS:
        'did:plc:nerv-moderation, did:web:seele.example',
    })
    expect(cfg.moderationServiceDids).toEqual([
      'did:plc:nerv-moderation',
      'did:web:seele.example',
    ])
  })

  it('drops empty entries', () => {
    const cfg = configFor({ STRATOS_MODERATION_SERVICE_DIDS: 'did:plc:a,,' })
    expect(cfg.moderationServiceDids).toEqual(['did:plc:a'])
  })
})

const SERVICE_DID = 'did:web:stratos.test'
const CREATE_LABEL_NSID = 'zone.stratos.moderation.createLabel'
const REJECTION_MESSAGE = 'Moderation service authorization failed'
const NOT_ALLOWLISTED_LABEL = 'did:web:nerv-moderation.example'

function createMockIdResolver(keypair: Secp256k1Keypair): IdResolver {
  const publicKeyMultibase = keypair.did().slice('did:key:'.length)
  return {
    did: {
      resolve: vi.fn().mockResolvedValue({
        id: keypair.did(),
        verificationMethod: [
          {
            id: `${keypair.did()}#key`,
            type: 'Multikey',
            controller: keypair.did(),
            publicKeyMultibase,
          },
        ],
      }),
    },
  } as unknown as IdResolver
}

function makeCtx(
  url: string,
  token?: string,
): Parameters<AuthVerifiers['moderationService']>[0] {
  return {
    req: {
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    },
    res: { setHeader: vi.fn() },
  } as unknown as Parameters<AuthVerifiers['moderationService']>[0]
}

const CREATE_LABEL_URL = `/xrpc/${CREATE_LABEL_NSID}`

describe('moderationService verifier', () => {
  let keypair: Secp256k1Keypair
  let idResolver: IdResolver
  let verifier: AuthVerifiers['moderationService']

  async function mint(
    overrides: Partial<{
      aud: string
      lxm: string | null
      exp: number
      keypair: Secp256k1Keypair
    }> = {},
  ): Promise<string> {
    const { lxm = CREATE_LABEL_NSID, keypair: signer, ...rest } = overrides
    return createServiceJwt({
      iss: keypair.did(),
      aud: SERVICE_DID,
      lxm,
      keypair: signer ?? keypair,
      ...rest,
    })
  }

  function buildVerifier(allowedIssuers: string[]) {
    return createModerationServiceVerifier({
      serviceDid: SERVICE_DID,
      idResolver,
      allowedIssuers,
    })
  }

  async function expectRejected(promise: Promise<unknown>) {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AuthRequiredError)
    expect((err as AuthRequiredError).message).toBe(REJECTION_MESSAGE)
  }

  beforeEach(async () => {
    keypair = await Secp256k1Keypair.create({ exportable: true })
    idResolver = createMockIdResolver(keypair)
    verifier = buildVerifier([keypair.did()])
  })

  describe('accepts', () => {
    it('allowlisted issuer with matching lxm and aud', async () => {
      const result = await verifier(makeCtx(CREATE_LABEL_URL, await mint()))
      expect(result).toEqual({
        credentials: {
          type: 'moderation-service',
          did: keypair.did(),
          iss: keypair.did(),
        },
      })
    })

    it('a request URL carrying a query string', async () => {
      const result = await verifier(
        makeCtx(`${CREATE_LABEL_URL}?uri=at%3A%2F%2Fx`, await mint()),
      )
      expect(result.credentials.iss).toBe(keypair.did())
    })
  })

  describe('issuer allowlist', () => {
    it('rejects a valid token from an issuer not on the allowlist', async () => {
      const other = buildVerifier([NOT_ALLOWLISTED_LABEL])
      await expectRejected(other(makeCtx(CREATE_LABEL_URL, await mint())))
    })

    it('rejects every issuer when the allowlist is empty', async () => {
      const empty = buildVerifier([])
      await expectRejected(empty(makeCtx(CREATE_LABEL_URL, await mint())))
    })
  })

  describe('lxm binding', () => {
    it('rejects a token with no lxm', async () => {
      const token = await mint({ lxm: null })
      await expectRejected(verifier(makeCtx(CREATE_LABEL_URL, token)))
    })

    it('rejects a token whose lxm names another method', async () => {
      const token = await mint({ lxm: 'zone.stratos.moderation.queryLabels' })
      await expectRejected(verifier(makeCtx(CREATE_LABEL_URL, token)))
    })
  })

  describe('token validity', () => {
    it('rejects a wrong aud', async () => {
      const token = await mint({ aud: 'did:web:seele.example' })
      await expectRejected(verifier(makeCtx(CREATE_LABEL_URL, token)))
    })

    it('rejects a token signed by a key not in the DID document', async () => {
      const intruder = await Secp256k1Keypair.create({ exportable: true })
      const token = await mint({ keypair: intruder })
      await expectRejected(verifier(makeCtx(CREATE_LABEL_URL, token)))
    })

    it('rejects an expired token', async () => {
      const token = await mint({ exp: Math.floor(Date.now() / 1000) - 60 })
      await expectRejected(verifier(makeCtx(CREATE_LABEL_URL, token)))
    })

    it('rejects a request with no Authorization header', async () => {
      await expectRejected(verifier(makeCtx(CREATE_LABEL_URL)))
    })

    it('rejects a malformed token', async () => {
      await expectRejected(verifier(makeCtx(CREATE_LABEL_URL, 'not-a-jwt')))
    })
  })
})

describe('moderationService verifier rejection logging', () => {
  type VerifierLogger = NonNullable<
    Parameters<typeof createModerationServiceVerifier>[0]['logger']
  >

  let keypair: Secp256k1Keypair
  let debug: ReturnType<typeof vi.fn>
  let otherLevels: ReturnType<typeof vi.fn>[]
  let logger: VerifierLogger

  function buildVerifier(
    idResolver: IdResolver,
    allowedIssuers: string[] = [keypair.did()],
  ) {
    return createModerationServiceVerifier({
      serviceDid: SERVICE_DID,
      idResolver,
      allowedIssuers,
      logger,
    })
  }

  function mint(
    overrides: Partial<{ aud: string; lxm: string | null }> = {},
  ): Promise<string> {
    const { lxm = CREATE_LABEL_NSID, ...rest } = overrides
    return createServiceJwt({
      iss: keypair.did(),
      aud: SERVICE_DID,
      lxm,
      keypair,
      ...rest,
    })
  }

  async function expectLoggedRejection(
    verifier: AuthVerifiers['moderationService'],
    token: string | undefined,
    reason: string,
  ) {
    const err = await verifier(makeCtx(CREATE_LABEL_URL, token)).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AuthRequiredError)
    expect((err as AuthRequiredError).message).toBe(REJECTION_MESSAGE)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalledWith(
      { reason },
      'moderation service auth rejected',
    )
    if (token) {
      const serialised = JSON.stringify(
        [debug, ...otherLevels].flatMap((spy) => spy.mock.calls),
      )
      expect(serialised).not.toContain(token)
    }
  }

  beforeEach(async () => {
    keypair = await Secp256k1Keypair.create({ exportable: true })
    debug = vi.fn()
    otherLevels = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
    const [info, warn, error, trace] = otherLevels
    logger = { debug, info, warn, error, trace } as unknown as VerifierLogger
  })

  it('logs a missing Authorization header', async () => {
    await expectLoggedRejection(
      buildVerifier(createMockIdResolver(keypair)),
      undefined,
      'missing authorization header',
    )
  })

  it('logs a token with no lxm', async () => {
    await expectLoggedRejection(
      buildVerifier(createMockIdResolver(keypair)),
      await mint({ lxm: null }),
      'lxm missing or mismatched',
    )
  })

  it('logs a valid token from an issuer that is not allowlisted', async () => {
    await expectLoggedRejection(
      buildVerifier(createMockIdResolver(keypair), [NOT_ALLOWLISTED_LABEL]),
      await mint(),
      'issuer not allowlisted',
    )
  })

  it('logs the underlying error message for a wrong aud', async () => {
    await expectLoggedRejection(
      buildVerifier(createMockIdResolver(keypair)),
      await mint({ aud: 'did:web:seele.example' }),
      'Invalid aud claim',
    )
  })

  it('logs a generic reason when resolution rejects with a non-Error', async () => {
    const idResolver = {
      did: { resolve: vi.fn().mockRejectedValue('did resolution exploded') },
    } as unknown as IdResolver
    await expectLoggedRejection(
      buildVerifier(idResolver),
      await mint(),
      'service auth verification failed',
    )
  })
})

describe('createAuthVerifiers moderationService wiring', () => {
  let dataDir: string
  let db: ServiceDb

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-moderation-verifier-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('exposes a verifier that reads the allowlist from config', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const cfg = createTestConfig(dataDir)
    cfg.moderationServiceDids = [keypair.did()]

    const verifiers = createAuthVerifiers(
      cfg.service.did,
      createMockIdResolver(keypair),
      cfg,
      {} as never,
      new SqliteAdminSessionStore(db),
      new SqliteAdminUserStore(db),
      [],
      {} as never,
      undefined,
      false,
      { did: () => cfg.service.did },
      undefined,
    )

    const token = await createServiceJwt({
      iss: keypair.did(),
      aud: cfg.service.did,
      lxm: CREATE_LABEL_NSID,
      keypair,
    })
    const result = await verifiers.moderationService(
      makeCtx(CREATE_LABEL_URL, token),
    )
    expect(result.credentials).toEqual({
      type: 'moderation-service',
      did: keypair.did(),
      iss: keypair.did(),
    })
  })
})

describe('moderationServiceOrService composition', () => {
  const QUERY_LABELS_NSID = 'zone.stratos.moderation.queryLabels'
  const QUERY_LABELS_URL = `/xrpc/${QUERY_LABELS_NSID}`

  let dataDir: string
  let db: ServiceDb
  let keypair: Secp256k1Keypair

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-moderation-composition-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    keypair = await Secp256k1Keypair.create({ exportable: true })
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  function buildVerifiers(allowedIssuers: string[]): AuthVerifiers {
    const cfg = createTestConfig(dataDir)
    cfg.moderationServiceDids = allowedIssuers
    return createAuthVerifiers(
      cfg.service.did,
      createMockIdResolver(keypair),
      cfg,
      {} as never,
      new SqliteAdminSessionStore(db),
      new SqliteAdminUserStore(db),
      [],
      {} as never,
      undefined,
      false,
      { did: () => cfg.service.did },
      undefined,
    )
  }

  async function mint(
    overrides: Partial<{
      aud: string
      lxm: string | null
      signer: Secp256k1Keypair
    }> = {},
  ): Promise<string> {
    const { lxm = QUERY_LABELS_NSID, signer, aud, ...rest } = overrides
    return createServiceJwt({
      iss: keypair.did(),
      aud: aud ?? createTestConfig(dataDir).service.did,
      lxm,
      keypair: signer ?? keypair,
      ...rest,
    })
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (e: unknown) => e,
    )
  }

  describe('allowlisted issuer', () => {
    it('accepts a token whose lxm is queryLabels as moderation-service', async () => {
      const verifiers = buildVerifiers([keypair.did()])
      const result = await verifiers.moderationServiceOrService(
        makeCtx(QUERY_LABELS_URL, await mint()),
      )
      expect(result.credentials).toEqual({
        type: 'moderation-service',
        did: keypair.did(),
        iss: keypair.did(),
      })
    })

    it('accepts a bearer scheme in another letter case', async () => {
      const verifiers = buildVerifiers([keypair.did()])
      const ctx = makeCtx(QUERY_LABELS_URL, await mint())
      const headers = ctx.req.headers as Record<string, string>
      headers.authorization = headers.authorization.replace('Bearer', 'BEARER')
      const result = await verifiers.moderationServiceOrService(ctx)
      expect(result.credentials.type).toBe('moderation-service')
    })

    it('rejects a token with no lxm instead of downgrading to service', async () => {
      const verifiers = buildVerifiers([keypair.did()])
      const token = await mint({ lxm: null })

      const accepted = await verifiers.service(makeCtx(QUERY_LABELS_URL, token))
      expect(accepted.credentials.type).toBe('service')

      const err = await rejection(
        verifiers.moderationServiceOrService(makeCtx(QUERY_LABELS_URL, token)),
      )
      expect(err).toBeInstanceOf(AuthRequiredError)
      expect((err as AuthRequiredError).message).toBe(REJECTION_MESSAGE)
    })

    it('rejects a token whose lxm names another method instead of downgrading', async () => {
      const verifiers = buildVerifiers([keypair.did()])
      const token = await mint({ lxm: CREATE_LABEL_NSID })

      const err = await rejection(
        verifiers.moderationServiceOrService(makeCtx(QUERY_LABELS_URL, token)),
      )
      expect(err).toBeInstanceOf(AuthRequiredError)
      expect((err as AuthRequiredError).message).toBe(REJECTION_MESSAGE)
    })

    it('rejects a token with no lxm when the header carries trailing data', async () => {
      const verifiers = buildVerifiers([keypair.did()])
      const token = await mint({ lxm: null })
      const ctx = makeCtx(QUERY_LABELS_URL, `${token} trailing`)

      const accepted = await verifiers.service(ctx)
      expect(accepted.credentials.type).toBe('service')

      const err = await rejection(verifiers.moderationServiceOrService(ctx))
      expect(err).toBeInstanceOf(AuthRequiredError)
      expect((err as AuthRequiredError).message).toBe(REJECTION_MESSAGE)
    })

    it('rejects a token whose lxm names another method when the header carries trailing data', async () => {
      const verifiers = buildVerifiers([keypair.did()])
      const token = await mint({ lxm: CREATE_LABEL_NSID })
      const ctx = makeCtx(QUERY_LABELS_URL, `${token} trailing`)

      const err = await rejection(verifiers.moderationServiceOrService(ctx))
      expect(err).toBeInstanceOf(AuthRequiredError)
      expect((err as AuthRequiredError).message).toBe(REJECTION_MESSAGE)
    })

    it('accepts a valid token as moderation-service when the header carries trailing data', async () => {
      const verifiers = buildVerifiers([keypair.did()])
      const ctx = makeCtx(QUERY_LABELS_URL, `${await mint()} trailing`)
      const result = await verifiers.moderationServiceOrService(ctx)
      expect(result.credentials).toEqual({
        type: 'moderation-service',
        did: keypair.did(),
        iss: keypair.did(),
      })
    })

    it('rejects a forged allowlisted issuer signed by an unknown key', async () => {
      const verifiers = buildVerifiers([keypair.did()])
      const intruder = await Secp256k1Keypair.create({ exportable: true })
      const token = await mint({ signer: intruder })

      const err = await rejection(
        verifiers.moderationServiceOrService(makeCtx(QUERY_LABELS_URL, token)),
      )
      expect(err).toBeInstanceOf(AuthRequiredError)
    })

    it('rejects an allowlisted issuer with the wrong aud instead of resolving to service', async () => {
      const verifiers = buildVerifiers([keypair.did()])
      const token = await mint({ aud: 'did:web:seele.example' })
      const err = await rejection(
        verifiers.moderationServiceOrService(makeCtx(QUERY_LABELS_URL, token)),
      )
      expect(err).toBeInstanceOf(AuthRequiredError)
    })
  })

  describe('issuer not on the allowlist', () => {
    it('resolves as service even when lxm is queryLabels', async () => {
      const verifiers = buildVerifiers([NOT_ALLOWLISTED_LABEL])
      const result = await verifiers.moderationServiceOrService(
        makeCtx(QUERY_LABELS_URL, await mint()),
      )
      expect(result.credentials.type).toBe('service')
      expect(result.credentials.iss).toBe(keypair.did())
    })

    it('resolves as service when the allowlist is empty', async () => {
      const verifiers = buildVerifiers([])
      const result = await verifiers.moderationServiceOrService(
        makeCtx(QUERY_LABELS_URL, await mint()),
      )
      expect(result.credentials.type).toBe('service')
    })

    it('passes a wrong aud through the service verifier as AuthRequiredError', async () => {
      const verifiers = buildVerifiers([NOT_ALLOWLISTED_LABEL])
      const token = await mint({ aud: 'did:web:seele.example' })
      const err = await rejection(
        verifiers.moderationServiceOrService(makeCtx(QUERY_LABELS_URL, token)),
      )
      expect(err).toBeInstanceOf(AuthRequiredError)
    })
  })

  describe('requests without a usable token', () => {
    it('rejects a missing Authorization header with AuthRequiredError', async () => {
      const verifiers = buildVerifiers([keypair.did()])
      const err = await rejection(
        verifiers.moderationServiceOrService(makeCtx(QUERY_LABELS_URL)),
      )
      expect(err).toBeInstanceOf(AuthRequiredError)
    })
  })
})

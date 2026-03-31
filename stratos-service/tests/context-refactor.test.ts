import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createAppContext } from '../src/context.js'
import {
  createTestConfig,
  createMockBlobStore,
  cborToRecord,
} from './utils/index.js'

describe('AppContext Refactoring', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-context-test-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('should initialize AppContext using refactored factories (SQLite)', async () => {
    const cfg = createTestConfig(testDir)
    const ctx = await createAppContext({
      cfg,
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })

    expect(ctx).toBeDefined()
    expect(ctx.db).toBeDefined()
    expect(ctx.actorStore).toBeDefined()
    expect(ctx.enrollmentStore).toBeDefined()
    expect(ctx.idResolver).toBeDefined()
    expect(ctx.oauthClient).toBeDefined()
    expect(ctx.signingKey).toBeDefined()

    await ctx.destroy()
  })

  it('should have a working health check', async () => {
    const cfg = createTestConfig(testDir)
    const ctx = await createAppContext({
      cfg,
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })

    const health = await ctx.checkHealth()
    expect(health.status).toBe('ok')
    expect(health.components.db).toBe('ok')

    await ctx.destroy()
  })
})

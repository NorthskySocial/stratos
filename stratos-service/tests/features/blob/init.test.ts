import { describe, expect, it } from 'vitest'
import type { BoundaryResolver } from '@northskysocial/stratos-core'
import type { ActorStore } from '../../../src/actor-store-types.js'
import {
  BlobAuthServiceImpl,
  initBlob,
} from '../../../src/features/blob/index.js'

describe('initBlob', () => {
  it('returns a blob authentication service', () => {
    const ctx = initBlob({} as ActorStore, {} as BoundaryResolver)
    expect(ctx.blobAuth).toBeInstanceOf(BlobAuthServiceImpl)
  })
})

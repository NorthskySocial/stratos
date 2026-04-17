import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { BloomManager } from '../../../src/features'

describe('BloomManager', () => {
  const cid1 = CID.parse(
    'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  )
  const cid2 = CID.parse(
    'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzvev6wt667vyrp7k4p72e',
  )

  it('should return true for a CID not yet in the filter (fallback to authoritative)', async () => {
    const manager = new BloomManager()
    expect(manager.checkBloom(cid1, ['boundary1'])).toBe(true)
  })

  it('should return true if there is a matching boundary', async () => {
    const manager = new BloomManager()
    await manager.updateBloom(cid1, ['boundary1', 'boundary2'])

    expect(manager.checkBloom(cid1, ['boundary1'])).toBe(true)
    expect(manager.checkBloom(cid1, ['boundary2'])).toBe(true)
    expect(manager.checkBloom(cid1, ['boundary1', 'boundary3'])).toBe(true)
  })

  it('should return false if there are no matching boundaries', async () => {
    const manager = new BloomManager()
    await manager.updateBloom(cid1, ['boundary1', 'boundary2'])

    expect(manager.checkBloom(cid1, ['boundary3'])).toBe(false)
    expect(manager.checkBloom(cid1, ['boundary4', 'boundary5'])).toBe(false)
  })

  it('should handle multiple CIDs correctly', async () => {
    const manager = new BloomManager()
    await manager.updateBloom(cid1, ['boundary1'])
    await manager.updateBloom(cid2, ['boundary2'])

    expect(manager.checkBloom(cid1, ['boundary1'])).toBe(true)
    expect(manager.checkBloom(cid1, ['boundary2'])).toBe(false)

    expect(manager.checkBloom(cid2, ['boundary2'])).toBe(true)
    expect(manager.checkBloom(cid2, ['boundary1'])).toBe(false)
  })

  it('should clear bloom entries', async () => {
    const manager = new BloomManager()
    await manager.updateBloom(cid1, ['boundary1'])
    expect(manager.checkBloom(cid1, ['boundary1'])).toBe(true)
    expect(manager.checkBloom(cid1, ['boundary2'])).toBe(false)

    await manager.clearBloom(cid1)
    // Should return true after clear as fallback to authoritative
    expect(manager.checkBloom(cid1, ['boundary1'])).toBe(true)
    expect(manager.checkBloom(cid1, ['boundary2'])).toBe(true)
  })

  it('should have a low false positive rate', async () => {
    const manager = new BloomManager()
    const boundaries = Array.from({ length: 10 }, (_, i) => `boundary${i}`)
    await manager.updateBloom(cid1, boundaries)

    let falsePositives = 0
    const testCount = 1000
    for (let i = 0; i < testCount; i++) {
      if (manager.checkBloom(cid1, [`other${i}`])) {
        falsePositives++
      }
    }

    // With 256 bits and 4 hashes for 10 items, FPR should be very low (well below 1%)
    const fpr = falsePositives / testCount
    expect(fpr).toBeLessThan(0.01)
  })
})

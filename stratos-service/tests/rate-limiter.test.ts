import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WriteRateLimiter } from '../src/shared/rate-limiter.js'

describe('WriteRateLimiter', () => {
  let rateLimiter: WriteRateLimiter
  const did = 'did:example:alice'

  beforeEach(() => {
    vi.useFakeTimers()
    rateLimiter = new WriteRateLimiter({
      maxWrites: 5,
      windowMs: 60000,
      cooldownMs: 10000,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('getSnapshot', () => {
    it('returns empty snapshot for unknown DID', () => {
      const now = Date.now()
      const snapshot = rateLimiter.getSnapshot(did)

      expect(snapshot).toEqual({
        inWindow: 0,
        maxWrites: 5,
        windowMs: 60000,
        cooldownUntil: 0,
        now,
      })
    })

    it('returns snapshot with current writes for known DID', () => {
      rateLimiter.assertWriteAllowed(did)
      rateLimiter.assertWriteAllowed(did)

      const now = Date.now()
      const snapshot = rateLimiter.getSnapshot(did)

      expect(snapshot.inWindow).toBe(2)
      expect(snapshot.now).toBe(now)
      expect(snapshot.cooldownUntil).toBe(0)
    })

    it('filters out expired timestamps from the snapshot', () => {
      rateLimiter.assertWriteAllowed(did)
      vi.advanceTimersByTime(30000)
      rateLimiter.assertWriteAllowed(did)
      
      // Still in window
      expect(rateLimiter.getSnapshot(did).inWindow).toBe(2)

      // Advance past first write
      vi.advanceTimersByTime(31000)
      
      const now = Date.now()
      const snapshot = rateLimiter.getSnapshot(did)
      expect(snapshot.inWindow).toBe(1)
      expect(snapshot.now).toBe(now)
    })

    it('reflects cooldown state in the snapshot', () => {
      // Consume all writes
      for (let i = 0; i < 5; i++) {
        rateLimiter.assertWriteAllowed(did)
      }
      
      expect(rateLimiter.getSnapshot(did).inWindow).toBe(5)
      expect(rateLimiter.getSnapshot(did).cooldownUntil).toBe(0)

      // Trigger cooldown
      const now = Date.now()
      try {
        rateLimiter.assertWriteAllowed(did)
      } catch (e) {
        // expected
      }

      const snapshot = rateLimiter.getSnapshot(did)
      expect(snapshot.cooldownUntil).toBe(now + 10000)
      expect(snapshot.inWindow).toBe(5)
    })
  })
})

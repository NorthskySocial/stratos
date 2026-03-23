import { XRPCError } from '@atproto/xrpc-server'

// Rate limit by DID as there's a perf drag when
// Concurrent messages for the same MST get too high

const DEFAULT_MAX_WRITES = 300
const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_COOLDOWN_MS = 10_000

export class RateLimitError extends XRPCError {
  retryAfter: number

  constructor(retryAfterSec: number) {
    super(
      429,
      `Write rate limit exceeded. Try again in ${retryAfterSec}s.`,
      'RateLimitExceeded',
    )
    this.retryAfter = retryAfterSec
  }
}

interface DidState {
  timestamps: number[]
  cooldownUntil: number
}

export interface WriteRateLimiterOpts {
  maxWrites?: number
  windowMs?: number
  cooldownMs?: number
  cooldownJitterMs?: number
}

export interface WriteRateSnapshot {
  inWindow: number
  maxWrites: number
  windowMs: number
  cooldownUntil: number
  now: number
}

export class WriteRateLimiter {
  private state = new Map<string, DidState>()
  private readonly maxWrites: number
  private readonly windowMs: number
  private readonly cooldownMs: number
  private readonly cooldownJitterMs: number

  constructor(opts: WriteRateLimiterOpts = {}) {
    this.maxWrites = opts.maxWrites ?? DEFAULT_MAX_WRITES
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.cooldownJitterMs = opts.cooldownJitterMs ?? 0
  }

  assertWriteAllowed(did: string, count = 1): void {
    const now = Date.now()
    let entry = this.state.get(did)

    if (!entry) {
      entry = { timestamps: [], cooldownUntil: 0 }
      this.state.set(did, entry)
    }

    if (now < entry.cooldownUntil) {
      const waitSec = Math.ceil((entry.cooldownUntil - now) / 1000)
      throw new RateLimitError(waitSec)
    }

    const windowStart = now - this.windowMs
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

    if (entry.timestamps.length + count > this.maxWrites) {
      const jitter =
        this.cooldownJitterMs > 0
          ? Math.floor(Math.random() * this.cooldownJitterMs)
          : 0
      entry.cooldownUntil = now + this.cooldownMs + jitter
      const waitSec = Math.ceil((this.cooldownMs + jitter) / 1000)
      throw new RateLimitError(waitSec)
    }

    for (let i = 0; i < count; i++) {
      entry.timestamps.push(now)
    }
  }

  getSnapshot(did: string): WriteRateSnapshot {
    const now = Date.now()
    const entry = this.state.get(did)
    if (!entry) {
      return {
        inWindow: 0,
        maxWrites: this.maxWrites,
        windowMs: this.windowMs,
        cooldownUntil: 0,
        now,
      }
    }

    const windowStart = now - this.windowMs
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

    return {
      inWindow: entry.timestamps.length,
      maxWrites: this.maxWrites,
      windowMs: this.windowMs,
      cooldownUntil: entry.cooldownUntil,
      now,
    }
  }
}

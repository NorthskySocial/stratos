import { XRPCError } from '@atproto/xrpc-server'

const DEFAULT_MAX_WRITES = 100
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
}

export class WriteRateLimiter {
  private state = new Map<string, DidState>()
  private readonly maxWrites: number
  private readonly windowMs: number
  private readonly cooldownMs: number

  constructor(opts: WriteRateLimiterOpts = {}) {
    this.maxWrites = opts.maxWrites ?? DEFAULT_MAX_WRITES
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
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
      entry.cooldownUntil = now + this.cooldownMs
      const waitSec = Math.ceil(this.cooldownMs / 1000)
      throw new RateLimitError(waitSec)
    }

    for (let i = 0; i < count; i++) {
      entry.timestamps.push(now)
    }
  }
}

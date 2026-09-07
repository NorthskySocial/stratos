import type { RequestHandler } from 'express'

/** Let approved clients distinguish transport time from server work. */
export function browserTiming(
  allowedOrigins: readonly string[],
): RequestHandler {
  return (req, res, next) => {
    res.vary('Origin')
    const origin = allowedOrigins.find(
      (allowed) => allowed === req.headers.origin,
    )
    if (origin !== undefined) {
      res.setHeader('Timing-Allow-Origin', origin)
    }
    next()
  }
}

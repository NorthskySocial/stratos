/**
 * Error thrown when the Stratos service returns a non-2xx response.
 */
export class StratosClientError extends Error {
  readonly status: number
  readonly body: string
  readonly url: string
  readonly lxm: string

  constructor(opts: {
    status: number
    body: string
    url: string
    lxm: string
    message?: string
  }) {
    super(
      opts.message ?? `Stratos request failed: ${opts.lxm} → ${opts.status}`,
    )
    this.name = 'StratosClientError'
    this.status = opts.status
    this.body = opts.body
    this.url = opts.url
    this.lxm = opts.lxm
  }
}

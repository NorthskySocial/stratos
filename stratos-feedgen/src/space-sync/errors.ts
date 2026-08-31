import { StratosError } from '@northskysocial/stratos-core'

/** Keeps every untrusted-host failure in the domain error taxonomy. */
export abstract class SpaceHostClientError extends StratosError {
  readonly url: string

  constructor(message: string, url: string, options?: ErrorOptions) {
    super(message, 'SpaceHostClientError', options)
    this.url = url
  }
}

/**
 * The host answered with a non-2xx XRPC response. `errorCode` carries the
 * XRPC `error` value verbatim for a code this client has no dedicated class
 * for (e.g. `RecordNotFound`, `RepoTakendown`) — member-skip, same as the
 * named subclasses below.
 */
export class SpaceHostRequestError extends SpaceHostClientError {
  readonly status: number
  readonly errorCode?: string
  readonly body: string

  constructor(opts: {
    status: number
    errorCode?: string
    body: string
    url: string
    message?: string
  }) {
    super(
      opts.message ??
        `space host request failed: ${opts.errorCode ?? opts.status} (${opts.url})`,
      opts.url,
    )
    this.name = 'SpaceHostRequestError'
    this.status = opts.status
    this.errorCode = opts.errorCode
    this.body = opts.body
  }
}

/** Cursor-reset: the stored cursor is not syntax this host accepts. */
export class MalformedCursorError extends SpaceHostRequestError {
  constructor(opts: { status: number; body: string; url: string }) {
    super({
      ...opts,
      errorCode: 'MalformedCursor',
      message: `space host rejected the sync cursor as malformed (${opts.url})`,
    })
    this.name = 'MalformedCursorError'
  }
}

/** Member-skip: this host has no repo for the member being synced. */
export class RepoNotFoundError extends SpaceHostRequestError {
  constructor(opts: { status: number; body: string; url: string }) {
    super({
      ...opts,
      errorCode: 'RepoNotFound',
      message: `space host has no repo for this member (${opts.url})`,
    })
    this.name = 'RepoNotFoundError'
  }
}

/** Member-skip: this host does not recognize the space being synced. */
export class SpaceNotFoundError extends SpaceHostRequestError {
  constructor(opts: { status: number; body: string; url: string }) {
    super({
      ...opts,
      errorCode: 'SpaceNotFound',
      message: `space host does not know this space (${opts.url})`,
    })
    this.name = 'SpaceNotFoundError'
  }
}

/** Member-skip: a 2xx body that is not the JSON shape the endpoint promises. */
export class SpaceHostInvalidResponseError extends SpaceHostClientError {
  constructor(url: string, reason: string) {
    super(`space host response was invalid: ${reason} (${url})`, url)
    this.name = 'SpaceHostInvalidResponseError'
  }
}

/** Member-skip: the response body ran past the configured byte cap. */
export class SpaceHostResponseTooLargeError extends SpaceHostClientError {
  readonly limitBytes: number

  constructor(url: string, limitBytes: number) {
    super(
      `space host response exceeded the ${limitBytes} byte cap (${url})`,
      url,
    )
    this.name = 'SpaceHostResponseTooLargeError'
    this.limitBytes = limitBytes
  }
}

/** Member-skip: the request did not complete within the configured timeout. */
export class SpaceHostTimeoutError extends SpaceHostClientError {
  constructor(url: string) {
    super(`space host request timed out (${url})`, url)
    this.name = 'SpaceHostTimeoutError'
  }
}

/** Member-skip: the host tried to redirect the request instead of answering it. */
export class SpaceHostRedirectError extends SpaceHostClientError {
  constructor(url: string) {
    super(`space host attempted a redirect (${url})`, url)
    this.name = 'SpaceHostRedirectError'
  }
}

/** Member-skip: the request could not reach the host at all (DNS, connection refused, TLS). */
export class SpaceHostUnreachableError extends SpaceHostClientError {
  constructor(url: string, options?: ErrorOptions) {
    super(`could not reach space host (${url})`, url, options)
    this.name = 'SpaceHostUnreachableError'
  }
}

/**
 * Member-skip: the host's origin is neither https nor on the explicit
 * plain-http allowlist. Thrown before any request is sent.
 */
export class InsecureHostOriginError extends SpaceHostClientError {
  constructor(origin: string) {
    super(`refusing insecure origin outside the allowlist: ${origin}`, origin)
    this.name = 'InsecureHostOriginError'
  }
}

/** Member-skip: the discovered host value is not a valid URL origin. */
export class InvalidHostOriginError extends SpaceHostClientError {
  constructor(origin: string, options?: ErrorOptions) {
    super(`space host origin was invalid: ${origin}`, origin, options)
    this.name = 'InvalidHostOriginError'
  }
}

/** Member-skip: the host resolves to an address that is not publicly routable. */
export class PrivateHostOriginError extends SpaceHostClientError {
  readonly address: string

  constructor(origin: string, address: string) {
    super(`space host resolved to a private address: ${address}`, origin)
    this.name = 'PrivateHostOriginError'
    this.address = address
  }
}

export abstract class MembershipEnumerationError extends StratosError {
  readonly boundary: string

  constructor(message: string, code: string, boundary: string) {
    super(message, code)
    this.boundary = boundary
  }
}

export class MembershipPageLimitError extends MembershipEnumerationError {
  readonly limit: number

  constructor(boundary: string, limit: number) {
    super(
      `space membership enumeration for boundary ${boundary} exceeded ${limit} pages`,
      'MembershipPageLimit',
      boundary,
    )
    this.name = 'MembershipPageLimitError'
    this.limit = limit
  }
}

export class MembershipCursorStalledError extends MembershipEnumerationError {
  readonly cursor: string

  constructor(boundary: string, cursor: string) {
    super(
      `space membership enumeration for boundary ${boundary} received a non-advancing cursor`,
      'MembershipCursorStalled',
      boundary,
    )
    this.name = 'MembershipCursorStalledError'
    this.cursor = cursor
  }
}

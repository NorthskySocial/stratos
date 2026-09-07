import { beforeEach, describe, expect, it, vi } from 'vitest'

let initializeClubhouseTelemetry: typeof import('./telemetry').initializeClubhouseTelemetry
let scrubEvent: typeof import('./telemetry').scrubEvent

beforeEach(async () => {
  // Reload module-level matchers while each mutation is active.
  vi.resetModules()
  ;({ initializeClubhouseTelemetry, scrubEvent } = await import('./telemetry'))
})

describe('Clubhouse telemetry', () => {
  it('does nothing when a browser DSN is absent', () => {
    expect(() => initializeClubhouseTelemetry({})).not.toThrow()
  })

  it.each(['url', 'from', 'to', 'url.full', 'http.url', 'http.target', 'URL'])(
    'removes query and fragment data from %s without losing the route',
    (field) => {
      for (const route of [
        'https://clubhouse.nerv.jp/oauth/callback',
        '/oauth/callback',
      ]) {
        for (const suffix of [
          '?code=private-code&state=private-state#room',
          '?%63ode=private-code&code=another-code&access_token=private-token',
          '#access_token=private-token&state=private-state',
          '',
        ]) {
          const event = { breadcrumbs: [{ data: { [field]: route + suffix } }] }
          expect(scrubEvent(event)).toEqual({
            breadcrumbs: [{ data: { [field]: route } }],
          })
          expect(event.breadcrumbs[0].data[field]).toBe(route + suffix)
        }
      }
    },
  )

  it('filters structured OAuth callback data and raw query strings', () => {
    expect(
      scrubEvent({
        request: {
          code: 'private-code',
          state: 'private-state',
          query_string: 'code=private-code',
        },
      }),
    ).toEqual({
      request: {
        code: '[Filtered]',
        state: '[Filtered]',
        query_string: '[Filtered]',
      },
    })
  })

  it.each([
    'authorization',
    'cookie',
    'set-cookie',
    'dpop',
    'dpop-nonce',
    'accesstoken',
    'access_token',
    'refresh-token',
    'id_token',
    'token',
    'clientsecret',
    'client_secret',
    'client-secret',
    'secret',
    'password',
    'post',
    'postBody',
    'oauth',
    'oauthcode',
    'authorizationcode',
    'authorization_code',
    'code',
    'codeverifier',
    'code_verifier',
    'state',
    'query_string',
    'CODE',
  ])('filters the exact credential field %s', (key) => {
    expect(scrubEvent({ extra: { [key]: 'private' } })).toEqual({
      extra: { [key]: '[Filtered]' },
    })
  })

  it('does not match partial credential or URL field names', () => {
    const event = {
      extra: {
        code_file: 'callback.ts',
        mystate: 'ready',
        return_url: '/room?selected=nerv',
        url_template: '/room?id=nerv',
      },
    }
    expect(scrubEvent(event)).toEqual(event)
  })

  it('preserves non-string URL fields and ordinary diagnostic values', () => {
    expect(
      scrubEvent({
        from: null,
        to: 401,
        url: { code: 'private-code' },
        message: 'Room status returned HTTP 401.',
      }),
    ).toEqual({
      from: null,
      to: 401,
      url: { code: '[Filtered]' },
      message: 'Room status returned HTTP 401.',
    })
  })

  it('scrubs credentials and post bodies while preserving diagnostic context', () => {
    expect(
      scrubEvent({
        request: {
          headers: { authorization: 'Bearer secret' },
          data: { client_secret: 'private client credential' },
        },
        contexts: {
          room: { id: 'nerv' },
          credentials: {
            'client-secret': 'private client credential',
            clientsecret: 'private client credential',
          },
        },
        extra: {
          postBody: 'private words',
          response: {
            status_code: 403,
            body: {
              error: 'ScopeMissingError',
              message: 'Missing required scope',
            },
          },
        },
      }),
    ).toEqual({
      request: {
        headers: { authorization: '[Filtered]' },
        data: '[Filtered]',
      },
      contexts: {
        room: { id: 'nerv' },
        credentials: {
          'client-secret': '[Filtered]',
          clientsecret: '[Filtered]',
        },
      },
      extra: {
        postBody: '[Filtered]',
        response: {
          status_code: 403,
          body: {
            error: 'ScopeMissingError',
            message: 'Missing required scope',
          },
        },
      },
    })
  })
})

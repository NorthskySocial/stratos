import { describe, expect, it } from 'vitest'
import { initializeClubhouseTelemetry, scrubEvent } from './telemetry'

describe('Clubhouse telemetry', () => {
  it('does nothing when a browser DSN is absent', () => {
    expect(() => initializeClubhouseTelemetry({})).not.toThrow()
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

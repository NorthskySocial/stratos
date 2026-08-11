/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://app.example/feed" }
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appBaseUrl, getClientId } from '../src/lib/auth'

describe('appBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('removes a trailing slash from the configured URL', () => {
    vi.stubEnv('VITE_WEBAPP_URL', 'https://kusanagi.example/')

    expect(appBaseUrl()).toBe('https://kusanagi.example')
    expect(getClientId()).toBe('https://kusanagi.example/client-metadata.json')
  })

  it('leaves a configured URL without a trailing slash alone', () => {
    vi.stubEnv('VITE_WEBAPP_URL', 'https://kusanagi.example')

    expect(appBaseUrl()).toBe('https://kusanagi.example')
  })

  it('falls back to the browser origin when no URL is configured', () => {
    vi.stubEnv('VITE_WEBAPP_URL', '')

    expect(appBaseUrl()).toBe('https://app.example')
    expect(getClientId()).toBe('https://app.example/client-metadata.json')
  })
})

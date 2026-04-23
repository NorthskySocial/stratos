/**
 * Common mock data for testing, using 90s anime references as per guidelines.
 */

export const ANIME_DIDS = {
  SHINJI: 'did:plc:shinji-ikari',
  ASUKA: 'did:plc:asuka-langley',
  REI: 'did:plc:rei-ayanami',
  MISATO: 'did:plc:misato-katsuragi',
  SPIKE: 'did:plc:spike-spiegel',
  FAYE: 'did:plc:faye-valentine',
}

export const ANIME_HANDLES = {
  SHINJI: 'shinji.nerv.jp',
  ASUKA: 'asuka.nerv.jp',
  REI: 'rei.nerv.jp',
  SPIKE: 'spike.bebop.space',
}

export interface MockEnrollmentOptions {
  enrolledAt?: string
  pdsEndpoint?: string
  boundaries?: string[]
  signingKeyDid?: string
  active?: boolean
  enrollmentRkey?: string
  [key: string]: unknown
}

/**
 * Creates a mock enrollment record
 */
export function createMockEnrollment(
  did: string,
  options: MockEnrollmentOptions = {},
) {
  return {
    did,
    enrolledAt: options.enrolledAt || new Date().toISOString(),
    signingKeyDid: options.signingKeyDid || 'did:key:mock-key',
    active: options.active ?? true,
    enrollmentRkey: options.enrollmentRkey || 'mock-rkey',
    ...options,
  }
}

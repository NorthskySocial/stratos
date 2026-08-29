import { describe, expect, it } from 'vitest'
import {
  resolveRepoHost,
  type DidPdsReader,
  type HostOverrideReader,
} from '../src'

const SPACE_URI = 'at://did:plc:misato/space/zone.stratos.space.feed/nerv'
const MEMBER_DID = 'did:plc:usagi'

const OVERRIDE_HOST = 'https://override.pds.example.com'
const DID_DOC_HOST = 'https://pds.example.com'

function overrideReader(host: string | undefined): HostOverrideReader {
  return { get: async () => host }
}

function didReader(host: string | undefined): DidPdsReader {
  return { getPdsEndpoint: async () => host }
}

function rejectingOverrideReader(): HostOverrideReader {
  return {
    get: async () => {
      throw new Error('ECONNREFUSED')
    },
  }
}

function rejectingDidReader(): DidPdsReader {
  return {
    getPdsEndpoint: async () => {
      throw new Error('ECONNREFUSED')
    },
  }
}

describe('resolveRepoHost', () => {
  it('resolves from the DID document when there is no override', async () => {
    const result = await resolveRepoHost(SPACE_URI, MEMBER_DID, {
      overrides: overrideReader(undefined),
      dids: didReader(DID_DOC_HOST),
    })
    expect(result).toEqual({ host: DID_DOC_HOST, source: 'did-document' })
  })

  it('prefers the authority-recorded override over the DID document', async () => {
    const result = await resolveRepoHost(SPACE_URI, MEMBER_DID, {
      overrides: overrideReader(OVERRIDE_HOST),
      dids: didReader(DID_DOC_HOST),
    })
    expect(result).toEqual({
      host: OVERRIDE_HOST,
      source: 'authority-override',
    })
  })

  it('never falls through to the DID document once an override is found', async () => {
    let didLookedUp = false
    const result = await resolveRepoHost(SPACE_URI, MEMBER_DID, {
      overrides: overrideReader(OVERRIDE_HOST),
      dids: {
        getPdsEndpoint: async () => {
          didLookedUp = true
          return DID_DOC_HOST
        },
      },
    })
    expect(result?.source).toBe('authority-override')
    expect(didLookedUp).toBe(false)
  })

  it('yields undefined for an unresolvable member, without throwing', async () => {
    const result = await resolveRepoHost(SPACE_URI, MEMBER_DID, {
      overrides: overrideReader(undefined),
      dids: didReader(undefined),
    })
    expect(result).toBeUndefined()
  })

  it('does not throw when the override lookup rejects, and falls through to the DID document', async () => {
    const result = await resolveRepoHost(SPACE_URI, MEMBER_DID, {
      overrides: rejectingOverrideReader(),
      dids: didReader(DID_DOC_HOST),
    })
    expect(result).toEqual({ host: DID_DOC_HOST, source: 'did-document' })
  })

  it('does not throw when the DID-document lookup rejects, and yields undefined', async () => {
    const result = await resolveRepoHost(SPACE_URI, MEMBER_DID, {
      overrides: overrideReader(undefined),
      dids: rejectingDidReader(),
    })
    expect(result).toBeUndefined()
  })

  it('does not throw when both lookups reject', async () => {
    const result = await resolveRepoHost(SPACE_URI, MEMBER_DID, {
      overrides: rejectingOverrideReader(),
      dids: rejectingDidReader(),
    })
    expect(result).toBeUndefined()
  })

  it('does not throw when a reader throws synchronously instead of rejecting', async () => {
    const result = await resolveRepoHost(SPACE_URI, MEMBER_DID, {
      overrides: {
        get: () => {
          throw new Error('synchronous reader bug')
        },
      },
      dids: {
        getPdsEndpoint: () => {
          throw new Error('synchronous reader bug')
        },
      },
    })
    expect(result).toBeUndefined()
  })

  it('falls through to the DID document when the override reader throws synchronously', async () => {
    const result = await resolveRepoHost(SPACE_URI, MEMBER_DID, {
      overrides: {
        get: () => {
          throw new Error('synchronous reader bug')
        },
      },
      dids: didReader(DID_DOC_HOST),
    })
    expect(result).toEqual({ host: DID_DOC_HOST, source: 'did-document' })
  })

  it('treats an empty-string override as absent and falls through to the DID document', async () => {
    const result = await resolveRepoHost(SPACE_URI, MEMBER_DID, {
      overrides: overrideReader(''),
      dids: didReader(DID_DOC_HOST),
    })
    expect(result).toEqual({ host: DID_DOC_HOST, source: 'did-document' })
  })
})

import { describe, expect, it } from 'vitest'

import {
  boundaryToSpaceUri,
  BoundaryWriteError,
  ScopeUpgradeRequiredError,
} from '../src'

const SERVICE_DID = 'did:web:nerv.example'
const SPACE_TYPE = 'zone.stratos.space.feed'
const MAX_DID_LENGTH = 2048
const SHORTEST_NSID = 'a.b.c'
const MAX_NSID_LENGTH = 253 + 1 + 63
const MAX_BOUNDARY_NAME_LENGTH = 512

const didOfLength = (length: number) =>
  `did:plc:${'a'.repeat(length - 'did:plc:'.length)}`

// A valid NSID of an exact length of at least 128: labels of up to 63
// letters joined by dots.
function longNsidOfLength(length: number): string {
  const labels: string[] = []
  let remaining = length
  while (remaining > 0) {
    const label = Math.min(63, remaining)
    labels.push('a'.repeat(label))
    remaining -= label + 1
  }
  return labels.join('.')
}

describe('boundaryToSpaceUri', () => {
  it('formats a valid boundary at the length limits', () => {
    const did = didOfLength(MAX_DID_LENGTH)
    const spaceType = longNsidOfLength(MAX_NSID_LENGTH)
    const name = 'a'.repeat(MAX_BOUNDARY_NAME_LENGTH)

    expect(boundaryToSpaceUri(`${did}/${name}`, spaceType)).toEqual({
      ok: true,
      value: `at:space/${did}/${spaceType}/${name}`,
    })
    expect(spaceType).toHaveLength(MAX_NSID_LENGTH)
    expect(boundaryToSpaceUri(`${SERVICE_DID}/a`, SHORTEST_NSID)).toEqual({
      ok: true,
      value: `at:space/${SERVICE_DID}/${SHORTEST_NSID}/a`,
    })
  })

  const refusals: Array<[string, string, string, string]> = [
    ['a boundary with no slash', 'geofront', SPACE_TYPE, 'geofront'],
    ['an empty boundary', '', SPACE_TYPE, 'boundary must be'],
    [
      'a service that is not a DID',
      'nerv.example/geofront',
      SPACE_TYPE,
      'invalid service DID: "nerv.example"',
    ],
    [
      'a DID with an uppercase method',
      'did:WEB:nerv.example/geofront',
      SPACE_TYPE,
      'invalid service DID',
    ],
    [
      'a DID that ends in a colon',
      'did:web:nerv.example:/geofront',
      SPACE_TYPE,
      'invalid service DID',
    ],
    [
      'a DID over the length limit',
      `${didOfLength(MAX_DID_LENGTH + 1)}/geofront`,
      SPACE_TYPE,
      'invalid service DID',
    ],
    [
      'a space type under the length limit',
      `${SERVICE_DID}/geofront`,
      SHORTEST_NSID.slice(1),
      'invalid space type NSID',
    ],
    [
      'a space type over the length limit',
      `${SERVICE_DID}/geofront`,
      longNsidOfLength(MAX_NSID_LENGTH + 1),
      'invalid space type NSID',
    ],
    [
      'a space type with an invalid character',
      `${SERVICE_DID}/geofront`,
      'zone.stratos.space.f_eed',
      'invalid space type NSID: "zone.stratos.space.f_eed"',
    ],
    [
      'a space type with one segment',
      `${SERVICE_DID}/geofront`,
      'geofront',
      'invalid space type NSID',
    ],
    [
      'a boundary name that is a dot',
      `${SERVICE_DID}/.`,
      SPACE_TYPE,
      'invalid boundary name: "."',
    ],
    [
      'a boundary name that is two dots',
      `${SERVICE_DID}/..`,
      SPACE_TYPE,
      'invalid boundary name: ".."',
    ],
    [
      'an empty boundary name',
      `${SERVICE_DID}/`,
      SPACE_TYPE,
      'invalid boundary name: ""',
    ],
    [
      'a boundary name over the length limit',
      `${SERVICE_DID}/${'a'.repeat(MAX_BOUNDARY_NAME_LENGTH + 1)}`,
      SPACE_TYPE,
      'invalid boundary name',
    ],
    [
      'a boundary name with a slash',
      `${SERVICE_DID}/geo/front`,
      SPACE_TYPE,
      'invalid boundary name: "geo/front"',
    ],
    [
      'a boundary name with a space',
      `${SERVICE_DID}/geo front`,
      SPACE_TYPE,
      'invalid boundary name',
    ],
  ]

  it.each(refusals)(
    'refuses %s and names the bad part',
    (_name, boundary, spaceType, reasonPart) => {
      const result = boundaryToSpaceUri(boundary, spaceType)

      expect(result.ok).toBe(false)
      const { reason } = result as { ok: false; reason: string }
      expect(reason.length).toBeGreaterThan(0)
      expect(reason).toContain(reasonPart)
    },
  )
})

describe('the write errors', () => {
  it('carry their own names', () => {
    const failure = new BoundaryWriteError(400, 'InvalidRecord', 'Angel')
    const upgrade = new ScopeUpgradeRequiredError(400, 'Authorize again')

    expect(failure.name).toBe('BoundaryWriteError')
    expect(upgrade.name).toBe('ScopeUpgradeRequiredError')
    expect(upgrade.errorName).toBe('ScopeUpgradeRequired')
    expect(String(upgrade)).toBe('ScopeUpgradeRequiredError: Authorize again')
  })
})

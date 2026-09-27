import { describe, expect, it } from 'vitest'
import {
  isPrivateHostAddress,
  parsePrivateHostPolicy,
} from '../src/space-sync/private-host-policy.js'

describe('operator private PDS host policy', () => {
  const origin = 'https://pds.seele.test'

  it('defaults to no private-host access and requires both settings', () => {
    expect(parsePrivateHostPolicy(undefined, undefined)).toBeUndefined()
    expect(() => parsePrivateHostPolicy(origin, undefined)).toThrow(
      /must be set together/,
    )
    expect(() => parsePrivateHostPolicy(undefined, '10.0.0.0/8')).toThrow(
      /must be set together/,
    )
  })

  it.each([
    'http://pds.seele.test',
    'https://unit:password@pds.seele.test',
    'https://pds.seele.test/path',
    'https://pds.seele.test?q=1',
    'https://pds.seele.test#section',
    'https://10.0.0.2',
    'https://[fc00::1]',
    'not-an-origin',
  ])('rejects untrusted origin syntax: %s', (value) => {
    expect(() => parsePrivateHostPolicy(value, '10.0.0.0/8')).toThrow()
  })

  it.each([
    '9.0.0.0/8',
    '11.0.0.0/8',
    '11.16.0.0/16',
    '11.168.0.0/16',
    '172.15.0.0/16',
    '172.32.0.0/16',
    '192.167.0.0/16',
    '192.169.0.0/16',
    '10.0.0.0/7',
    '10.0.0.0/31',
    '10.0.0.0/32',
    '10.0.0.0/33',
    '10.0.0.1/24',
    '266.8.0.0/8',
    'x10.0.0.0/8',
    '10.0.0.0/8x',
    'garbage',
    '10.0.0.0/8,',
    Array(17).fill('10.0.0.0/8').join(','),
  ])('rejects unsafe or malformed CIDRs: %s', (value) => {
    expect(() => parsePrivateHostPolicy(origin, value)).toThrow()
  })

  it('accepts the configured CIDR count and /30 usable hosts', () => {
    const policy = parsePrivateHostPolicy(
      ` ${origin} `,
      `${Array(15).fill('172.16.0.0/12').join(',')}, 10.42.0.0/30 `,
    )!
    expect(policy.networks).toHaveLength(16)
    expect(isPrivateHostAddress('10.42.0.1', policy)).toBe(true)
    expect(isPrivateHostAddress('10.42.0.2', policy)).toBe(true)
    expect(isPrivateHostAddress('10.42.0.3', policy)).toBe(false)
  })

  it.each([
    ['10.0.0.0/8', '10.1.2.3'],
    ['172.16.0.0/12', '172.31.1.2'],
    ['192.168.0.0/16', '192.168.4.5'],
  ])('accepts private network %s and usable host %s', (cidr, host) => {
    const policy = parsePrivateHostPolicy(origin, cidr)
    expect(policy).toBeDefined()
    expect(isPrivateHostAddress(host, policy!)).toBe(true)
  })

  it('excludes network, broadcast, other networks, and IPv6 answers', () => {
    const policy = parsePrivateHostPolicy(
      origin,
      '172.25.111.0/24,10.42.0.0/16',
    )!
    expect(policy.origin).toBe(origin)
    for (const address of ['172.25.111.1', '172.25.111.254', '10.42.1.5']) {
      expect(isPrivateHostAddress(address, policy)).toBe(true)
    }
    for (const address of [
      '172.25.111.0',
      '172.25.111.255',
      '172.25.110.1',
      '10.43.1.5',
      '8.8.8.8',
      'fc00::1',
    ]) {
      expect(isPrivateHostAddress(address, policy)).toBe(false)
    }
  })
})

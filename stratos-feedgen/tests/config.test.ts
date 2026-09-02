import {
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPACE_MEMBERSHIP_PAGE_LIMIT,
  DEFAULT_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS,
  DEFAULT_SPACE_SYNC_ALLOW_HTTP_ORIGINS,
  DEFAULT_SPACE_SYNC_ENABLED,
  DEFAULT_SPACE_SYNC_INTERVAL_MS,
  DEFAULT_SPACE_SYNC_MAX_PAGES,
  DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES,
  DEFAULT_SPACE_SYNC_MAX_RECORDS_PER_MEMBER,
  DEFAULT_SPACE_SYNC_MEMBER_BUDGET_MS,
  DEFAULT_SPACE_SYNC_PAGE_LIMIT,
  DEFAULT_SPACE_SYNC_REQUEST_TIMEOUT_MS,
  MAX_SPACE_MEMBERSHIP_PAGE_LIMIT,
  loadFeedgenConfig,
} from '../src/config.js'

// 90s-anime crew DIDs, matching the other space-sync fixtures.
const baseEnv = {
  FEEDGEN_SERVICE_DID: 'did:web:feedgen.bebop.test',
  FEEDGEN_SIGNING_KEY: 'unused-by-this-test',
  STRATOS_SERVICE_URL: 'https://stratos.bebop.test',
  STRATOS_SERVICE_DID: 'did:web:stratos.bebop.test',
  FEEDGEN_SQLITE_PATH: '/tmp/feedgen-bebop.sqlite',
}

describe('loadFeedgenConfig SQLite storage split', () => {
  it('derives a distinct sibling database for durable membership snapshots', () => {
    const cfg = loadFeedgenConfig({ ...baseEnv })

    expect(cfg.sqlitePath).toBe('/tmp/feedgen-bebop.sqlite')
    expect(cfg.membershipSqlitePath).toBe(
      '/tmp/feedgen-bebop.sqlite.membership',
    )
  })

  it('keeps an explicitly configured membership database path', () => {
    const cfg = loadFeedgenConfig({
      ...baseEnv,
      FEEDGEN_MEMBERSHIP_SQLITE_PATH: '/var/lib/feedgen/membership.sqlite',
    })

    expect(cfg.membershipSqlitePath).toBe('/var/lib/feedgen/membership.sqlite')
  })

  it('requires an explicit disk membership path for an in-memory record index', () => {
    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SQLITE_PATH: ':memory:',
      }),
    ).toThrow(/FEEDGEN_MEMBERSHIP_SQLITE_PATH/)

    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SQLITE_PATH: ':memory:',
        FEEDGEN_MEMBERSHIP_SQLITE_PATH: ':memory:',
      }),
    ).toThrow(/must be a file path/)

    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SQLITE_PATH: ':memory:',
        FEEDGEN_MEMBERSHIP_SQLITE_PATH: ':memory:?cache=shared',
      }),
    ).toThrow(/must be a file path/)

    expect(
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SQLITE_PATH: ':memory:',
        FEEDGEN_MEMBERSHIP_SQLITE_PATH: '/var/lib/feedgen/membership.sqlite',
      }).membershipSqlitePath,
    ).toBe('/var/lib/feedgen/membership.sqlite')
  })

  it('rejects a membership database that aliases the record database', () => {
    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_MEMBERSHIP_SQLITE_PATH: baseEnv.FEEDGEN_SQLITE_PATH,
      }),
    ).toThrow(/must differ/)

    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SQLITE_PATH: '/tmp/feedgen-bebop.sqlite',
        FEEDGEN_MEMBERSHIP_SQLITE_PATH: '/tmp/./feedgen-bebop.sqlite',
      }),
    ).toThrow(/must differ/)
  })

  it('rejects a membership database symlink', () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedgen-config-'))
    const recordPath = join(directory, 'record.sqlite')
    const membershipPath = join(directory, 'membership.sqlite')
    try {
      symlinkSync(recordPath, membershipPath)
      expect(() =>
        loadFeedgenConfig({
          ...baseEnv,
          FEEDGEN_SQLITE_PATH: recordPath,
          FEEDGEN_MEMBERSHIP_SQLITE_PATH: membershipPath,
        }),
      ).toThrow(/symbolic link/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects membership and record hard links to the same file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedgen-config-'))
    const recordPath = join(directory, 'record.sqlite')
    const membershipPath = join(directory, 'membership.sqlite')
    try {
      writeFileSync(recordPath, '')
      linkSync(recordPath, membershipPath)
      expect(() =>
        loadFeedgenConfig({
          ...baseEnv,
          FEEDGEN_SQLITE_PATH: recordPath,
          FEEDGEN_MEMBERSHIP_SQLITE_PATH: membershipPath,
        }),
      ).toThrow(/must differ/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('loadFeedgenConfig space-sync defaults', () => {
  it('leaves request-timeout headroom above worst-case default host resolution', () => {
    const resolverWorkers = 10
    const resolverTimeoutMs = 3_000
    const resolverOnlyWorstCaseMs =
      Math.ceil(DEFAULT_SPACE_MEMBERSHIP_PAGE_LIMIT / resolverWorkers) *
      resolverTimeoutMs

    expect(DEFAULT_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS).toBeGreaterThan(
      resolverOnlyWorstCaseMs,
    )
  })

  it('applies every space-sync default when no env vars are set', () => {
    const cfg = loadFeedgenConfig({ ...baseEnv })
    expect(cfg.spaceSyncEnabled).toBe(DEFAULT_SPACE_SYNC_ENABLED)
    expect(cfg.spaceSyncIntervalMs).toBe(DEFAULT_SPACE_SYNC_INTERVAL_MS)
    expect(cfg.spaceMembershipPageLimit).toBe(
      DEFAULT_SPACE_MEMBERSHIP_PAGE_LIMIT,
    )
    expect(cfg.spaceMembershipRequestTimeoutMs).toBe(
      DEFAULT_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS,
    )
    expect(cfg.spaceSyncPageLimit).toBe(DEFAULT_SPACE_SYNC_PAGE_LIMIT)
    expect(cfg.spaceSyncMaxPages).toBe(DEFAULT_SPACE_SYNC_MAX_PAGES)
    expect(cfg.spaceSyncRequestTimeoutMs).toBe(
      DEFAULT_SPACE_SYNC_REQUEST_TIMEOUT_MS,
    )
    expect(cfg.spaceSyncMemberBudgetMs).toBe(
      DEFAULT_SPACE_SYNC_MEMBER_BUDGET_MS,
    )
    expect(cfg.spaceSyncMemberConcurrency).toBe(8)
    expect(cfg.spaceSyncMaxRecordBytes).toBe(
      DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES,
    )
    expect(cfg.spaceSyncMaxRecordsPerMember).toBe(
      DEFAULT_SPACE_SYNC_MAX_RECORDS_PER_MEMBER,
    )
    expect(cfg.spaceSyncAllowHttpOrigins).toEqual(
      DEFAULT_SPACE_SYNC_ALLOW_HTTP_ORIGINS,
    )
    expect(cfg.spaceSyncAllowHttpOrigins.size).toBe(0)
  })

  it('treats an empty string the same as unset for numeric, boolean, and list knobs', () => {
    const cfg = loadFeedgenConfig({
      ...baseEnv,
      FEEDGEN_SPACE_SYNC_ENABLED: '',
      FEEDGEN_SPACE_SYNC_INTERVAL_MS: '',
      FEEDGEN_SPACE_MEMBERSHIP_PAGE_LIMIT: '',
      FEEDGEN_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS: '',
      FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS: '',
    })
    expect(cfg.spaceSyncEnabled).toBe(DEFAULT_SPACE_SYNC_ENABLED)
    expect(cfg.spaceSyncIntervalMs).toBe(DEFAULT_SPACE_SYNC_INTERVAL_MS)
    expect(cfg.spaceMembershipPageLimit).toBe(
      DEFAULT_SPACE_MEMBERSHIP_PAGE_LIMIT,
    )
    expect(cfg.spaceMembershipRequestTimeoutMs).toBe(
      DEFAULT_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS,
    )
    expect(cfg.spaceSyncAllowHttpOrigins.size).toBe(0)
  })
})

describe('loadFeedgenConfig space-sync overrides', () => {
  it('parses an explicit override for every numeric knob', () => {
    const cfg = loadFeedgenConfig({
      ...baseEnv,
      FEEDGEN_SPACE_SYNC_INTERVAL_MS: '15000',
      FEEDGEN_SPACE_MEMBERSHIP_PAGE_LIMIT: '200',
      FEEDGEN_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS: '4000',
      FEEDGEN_SPACE_SYNC_PAGE_LIMIT: '250',
      FEEDGEN_SPACE_SYNC_MAX_PAGES: '4',
      FEEDGEN_SPACE_SYNC_REQUEST_TIMEOUT_MS: '5000',
      FEEDGEN_SPACE_SYNC_MEMBER_BUDGET_MS: '20000',
      FEEDGEN_SPACE_SYNC_MEMBER_CONCURRENCY: '3',
      FEEDGEN_SPACE_SYNC_MAX_RECORD_BYTES: '131072',
      FEEDGEN_SPACE_SYNC_MAX_RECORDS_PER_MEMBER: '500',
    })
    expect(cfg.spaceSyncIntervalMs).toBe(15_000)
    expect(cfg.spaceMembershipPageLimit).toBe(200)
    expect(cfg.spaceMembershipRequestTimeoutMs).toBe(4_000)
    expect(cfg.spaceSyncPageLimit).toBe(250)
    expect(cfg.spaceSyncMaxPages).toBe(4)
    expect(cfg.spaceSyncRequestTimeoutMs).toBe(5_000)
    expect(cfg.spaceSyncMemberBudgetMs).toBe(20_000)
    expect(cfg.spaceSyncMemberConcurrency).toBe(3)
    expect(cfg.spaceSyncMaxRecordBytes).toBe(131_072)
    expect(cfg.spaceSyncMaxRecordsPerMember).toBe(500)
  })

  it('rejects a non-positive-integer override', () => {
    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_MEMBERSHIP_PAGE_LIMIT: '0',
      }),
    ).toThrow(/FEEDGEN_SPACE_MEMBERSHIP_PAGE_LIMIT/)

    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS: '0',
      }),
    ).toThrow(/FEEDGEN_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS/)

    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_SYNC_PAGE_LIMIT: '0',
      }),
    ).toThrow(/FEEDGEN_SPACE_SYNC_PAGE_LIMIT/)

    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_SYNC_MEMBER_CONCURRENCY: '0',
      }),
    ).toThrow(/FEEDGEN_SPACE_SYNC_MEMBER_CONCURRENCY/)
  })

  it('rejects a page limit above the upstream maximum', () => {
    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_MEMBERSHIP_PAGE_LIMIT: String(
          MAX_SPACE_MEMBERSHIP_PAGE_LIMIT + 1,
        ),
      }),
    ).toThrow(/FEEDGEN_SPACE_MEMBERSHIP_PAGE_LIMIT.*maximum 1000/)

    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_SYNC_PAGE_LIMIT: '1001',
      }),
    ).toThrow(/FEEDGEN_SPACE_SYNC_PAGE_LIMIT.*maximum 1000/)
  })
})

describe('loadFeedgenConfig FEEDGEN_SPACE_SYNC_ENABLED', () => {
  it('parses "false" as false', () => {
    const cfg = loadFeedgenConfig({
      ...baseEnv,
      FEEDGEN_SPACE_SYNC_ENABLED: 'false',
    })
    expect(cfg.spaceSyncEnabled).toBe(false)
  })

  it('parses "true" as true', () => {
    const cfg = loadFeedgenConfig({
      ...baseEnv,
      FEEDGEN_SPACE_SYNC_ENABLED: 'true',
    })
    expect(cfg.spaceSyncEnabled).toBe(true)
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(
      loadFeedgenConfig({ ...baseEnv, FEEDGEN_SPACE_SYNC_ENABLED: 'FALSE' })
        .spaceSyncEnabled,
    ).toBe(false)
    expect(
      loadFeedgenConfig({ ...baseEnv, FEEDGEN_SPACE_SYNC_ENABLED: '  True  ' })
        .spaceSyncEnabled,
    ).toBe(true)
  })

  it('rejects a value that is neither true nor false', () => {
    expect(() =>
      loadFeedgenConfig({ ...baseEnv, FEEDGEN_SPACE_SYNC_ENABLED: 'yes' }),
    ).toThrow(/FEEDGEN_SPACE_SYNC_ENABLED/)
  })
})

describe('loadFeedgenConfig FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS', () => {
  it('parses a comma list of bare literal-loopback http origins into a Set of exact origins', () => {
    const cfg = loadFeedgenConfig({
      ...baseEnv,
      FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS:
        'http://localhost, http://127.0.0.1:8080, http://[::1]:9090',
    })
    expect(cfg.spaceSyncAllowHttpOrigins).toEqual(
      new Set([
        'http://localhost',
        'http://127.0.0.1:8080',
        'http://[::1]:9090',
      ]),
    )
  })

  it.each(['http://bebop.test', 'http://sub.localhost'])(
    'rejects a non-literal loopback origin: %s',
    (origin) => {
      expect(() =>
        loadFeedgenConfig({
          ...baseEnv,
          FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS: origin,
        }),
      ).toThrow(/literal loopback origin/)
    },
  )

  it('rejects an https:// entry, since https is always allowed and never belongs in this list', () => {
    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS: 'https://jet.bebop.test',
      }),
    ).toThrow(/expected an http:\/\/ origin/)
  })

  it('rejects an entry that is not a valid URL', () => {
    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS: 'not-a-url',
      }),
    ).toThrow(/not a valid URL/)
  })

  it('rejects an entry with a path, query, or userinfo', () => {
    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS: 'http://jet.bebop.test/repo',
      }),
    ).toThrow(/bare origin/)

    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS: 'http://jet.bebop.test?x=1',
      }),
    ).toThrow(/bare origin/)

    expect(() =>
      loadFeedgenConfig({
        ...baseEnv,
        FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS: 'http://spike:pass@jet.bebop.test',
      }),
    ).toThrow(/bare origin/)
  })
})

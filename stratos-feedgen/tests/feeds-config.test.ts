import { describe, expect, it } from 'vitest'
import {
  buildFeedRegistry,
  loadFeedRegistry,
  type FeedDescription,
} from '../src/feeds/index.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('buildFeedRegistry', () => {
  it('indexes feeds by id', () => {
    const feeds: FeedDescription[] = [
      { id: 'eng', boundary: 'engineering' },
      { id: 'lead', boundary: 'leadership', displayName: 'Leadership' },
    ]
    const registry = buildFeedRegistry(feeds)
    expect(registry.list()).toHaveLength(2)
    expect(registry.get('eng')?.boundary).toBe('engineering')
    expect(registry.get('lead')?.displayName).toBe('Leadership')
    expect(registry.get('missing')).toBeUndefined()
  })

  it('rejects duplicate ids', () => {
    expect(() =>
      buildFeedRegistry([
        { id: 'eng', boundary: 'engineering' },
        { id: 'eng', boundary: 'leadership' },
      ]),
    ).toThrow(/Duplicate feed id/)
  })
})

describe('loadFeedRegistry', () => {
  it('loads from FEEDGEN_FEEDS_JSON', () => {
    const env = {
      FEEDGEN_FEEDS_JSON: JSON.stringify({
        feeds: [{ id: 'eng', boundary: 'engineering' }],
      }),
    }
    const registry = loadFeedRegistry(env)
    expect(registry.list()).toHaveLength(1)
  })

  it('loads from FEEDGEN_FEEDS_FILE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feedgen-feeds-'))
    const path = join(dir, 'feeds.json')
    writeFileSync(
      path,
      JSON.stringify({
        feeds: [{ id: 'lead', boundary: 'leadership' }],
      }),
    )
    const registry = loadFeedRegistry({ FEEDGEN_FEEDS_FILE: path })
    expect(registry.get('lead')?.boundary).toBe('leadership')
  })

  it('rejects when neither env var is set', () => {
    expect(() => loadFeedRegistry({})).toThrow(
      /FEEDGEN_FEEDS_FILE.*FEEDGEN_FEEDS_JSON.*FEEDGEN_FEEDS_YAML/,
    )
  })

  it('rejects when multiple env vars are set', () => {
    expect(() =>
      loadFeedRegistry({
        FEEDGEN_FEEDS_FILE: '/tmp/x.json',
        FEEDGEN_FEEDS_JSON: '{"feeds":[]}',
      }),
    ).toThrow(/Set only one/)
  })

  it('rejects invalid JSON', () => {
    expect(() => loadFeedRegistry({ FEEDGEN_FEEDS_JSON: 'not json' })).toThrow(
      /not valid JSON/,
    )
  })

  it('rejects missing required fields', () => {
    expect(() =>
      loadFeedRegistry({
        FEEDGEN_FEEDS_JSON: JSON.stringify({
          feeds: [{ id: 'eng' }],
        }),
      }),
    ).toThrow(/boundary is required/)
  })

  it('loads from FEEDGEN_FEEDS_YAML', () => {
    const yaml = [
      'feeds:',
      '  - id: eng',
      '    boundary: engineering',
      '    displayName: Engineering',
      '  - id: lead',
      '    boundary: leadership',
    ].join('\n')
    const registry = loadFeedRegistry({ FEEDGEN_FEEDS_YAML: yaml })
    expect(registry.list()).toHaveLength(2)
    expect(registry.get('eng')?.displayName).toBe('Engineering')
    expect(registry.get('lead')?.boundary).toBe('leadership')
  })

  it('loads YAML from FEEDGEN_FEEDS_FILE by extension', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feedgen-feeds-'))
    const path = join(dir, 'feeds.yaml')
    writeFileSync(
      path,
      'feeds:\n  - id: eng\n    boundary: engineering\n',
    )
    const registry = loadFeedRegistry({ FEEDGEN_FEEDS_FILE: path })
    expect(registry.get('eng')?.boundary).toBe('engineering')
  })

  it('rejects file with unsupported extension', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feedgen-feeds-'))
    const path = join(dir, 'feeds.txt')
    writeFileSync(path, 'feeds: []')
    expect(() => loadFeedRegistry({ FEEDGEN_FEEDS_FILE: path })).toThrow(
      /Unsupported feed config extension/,
    )
  })
})

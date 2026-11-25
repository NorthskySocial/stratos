import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  JOURNEYS,
  renderJourneyChecklist,
  runnerCommand,
} from './interop-journeys.js'
import { suite as novemberInterop } from '../scenarios/november-interop.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const checklist = readFileSync(resolve(HERE, 'INTEROP.md'), 'utf8')

const SUITES_IN_ORDER = [
  'ordinary-custody',
  'delegation-transport',
  'credential-lifetime',
  'client-custody',
  'space-delete',
  'feed-errors',
  'service-admission',
  'standard-credential-transport',
  'rust-production-interop',
  'november-interop',
]

describe('the interop checklist', () => {
  it('holds the journey list the suite is built from, unchanged', () => {
    expect(checklist).toContain(renderJourneyChecklist())
  })

  it('has one item for each journey the suite requires', () => {
    for (const id of novemberInterop.requiredAssertions)
      expect(checklist, id).toContain('`' + id + '`')
    expect(checklist.match(/^### \d+\. `/gm)).toHaveLength(JOURNEYS.length)
  })

  it('gives the exact command of every suite, with the digest only for the prepared one', () => {
    for (const suite of ['baseline', ...SUITES_IN_ORDER])
      expect(checklist, suite).toContain(runnerCommand(suite))
    expect(runnerCommand('baseline')).not.toContain('--pds-image-digest')
    expect(runnerCommand('november-interop')).toContain('--pds-image-digest')
  })

  it('walks the suites in the order it lists them', () => {
    const positions = SUITES_IN_ORDER.map((suite) =>
      checklist.indexOf(`--suite ${suite} \\`),
    )
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('distinguishes the diagnostic baseline from the recorded host probe', () => {
    expect(checklist).toContain(
      'The baseline is a diagnostic here, never acceptance',
    )
    expect(checklist.replace(/\s+/g, ' ')).toContain(
      'The November 26 probe and its URI receipt record a successful dotted-authority journey',
    )
  })

  it('carries each question the earlier probes left', () => {
    expect(checklist.replace(/\s+/g, ' ')).toContain(
      'Does a host check the space authority or membership on a write?',
    )
    expect(checklist.replace(/\s+/g, ' ')).toContain(
      'accept a credential that a foreign authority minted',
    )
  })
})

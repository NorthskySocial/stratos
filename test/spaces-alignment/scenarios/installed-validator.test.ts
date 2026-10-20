import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSpaceUri } from '../../../stratos-core/src/spaces/domain.js'

const serviceRequire = createRequire(
  new URL('../../../stratos-service/package.json', import.meta.url),
)
const { Lexicons } = serviceRequire(
  '@atproto/lexicon',
) as typeof import('@atproto/lexicon')
const packagePath = join(
  dirname(serviceRequire.resolve('@atproto/lexicon')),
  '../package.json',
)
const installed = JSON.parse(readFileSync(packagePath, 'utf8')) as {
  version: string
}
const id = 'zone.stratos.test.spaceReference'
const schema = {
  lexicon: 1 as const,
  id,
  defs: {
    main: {
      type: 'object' as const,
      required: ['space'],
      properties: {
        space: { type: 'string' as const, format: 'space-ref' as const },
      },
    },
  },
}

describe('installed service space-ref validator', () => {
  it('records the installed version and accepts a space-ref schema', () => {
    expect(installed.version).toBe('0.7.11')
    expect(() => new Lexicons([schema])).not.toThrow()
  })
  it.each([
    ['at://did:plc:motoko/space/zone.stratos.space.feed/general', true],
    ['not a space', false],
    ['at://did:plc:motoko/space/zone.stratos.space.feed', false],
  ])(
    'does not enforce string format for %s; runtime parsing remains strict',
    (space, valid) => {
      const lexicons = new Lexicons([schema])
      const input = { space }
      expect(lexicons.validate(id, input)).toEqual({
        success: true,
        value: input,
      })
      expect(input.space).toBe(space)
      expect(parseSpaceUri(space).ok).toBe(valid)
    },
  )
  it('still enforces the declared string type', () => {
    expect(new Lexicons([schema]).validate(id, { space: 42 }).success).toBe(
      false,
    )
  })
})

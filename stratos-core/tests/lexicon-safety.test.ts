import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { stratosLexicons } from '../src'

describe('Lexicon Registration Safety', () => {
  it('should ensure all lexicons used in webapp are registered in stratos-core', () => {
    const webappDir = path.resolve(__dirname, '../../webapp/src')
    const lexiconIdRegex = /zone\.stratos\.[a-zA-Z0-9.]+/g
    const foundLexicons = new Set<string>()

    function scanDir(dir: string) {
      const files = fs.readdirSync(dir)
      for (const file of files) {
        const fullPath = path.join(dir, file)
        if (fs.statSync(fullPath).isDirectory()) {
          scanDir(fullPath)
        } else if (file.endsWith('.svelte') || file.endsWith('.ts')) {
          const content = fs.readFileSync(fullPath, 'utf-8')
          let match
          while ((match = lexiconIdRegex.exec(content)) !== null) {
            foundLexicons.add(match[0])
          }
        }
      }
    }

    scanDir(webappDir)

    // Lexicons we expect to be registered
    const registeredLexiconIds = stratosLexicons.map((l) => l.id)

    console.log('Found lexicons in webapp:', Array.from(foundLexicons))

    for (const lexiconId of foundLexicons) {
      // Some might be definitions, not top-level lexicons
      const baseId = lexiconId.split('#')[0]
      expect(registeredLexiconIds).toContain(baseId)
    }
  })
})

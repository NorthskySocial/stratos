import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface GlossaryEntry {
  slug: string
  anchor: string
  term: string
  definition: string
}

declare const data: GlossaryEntry[]
export { data }

const GLOSSARY_FILE = fileURLToPath(new URL('./glossary.md', import.meta.url))

// The glossary page is the one source for term definitions. <Term> reads the
// first paragraph under each `###` heading, with links reduced to their text.
function parseGlossary(markdown: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = []
  for (const section of markdown.split(/^### /m).slice(1)) {
    const [heading, ...rest] = section.split('\n')
    const firstParagraph = rest
      .join('\n')
      .split(/\n\s*\n|\n#/)
      .map((block) => block.trim())
      .find((block) => block !== '')
    if (firstParagraph === undefined) continue
    const term = heading.trim()
    entries.push({
      slug: slugify(term),
      anchor: headingAnchor(term),
      term,
      definition: firstParagraph
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s*\n\s*/g, ' '),
    })
  }
  return entries
}

// Matches the id VitePress gives the `###` heading, for links into the page.
function headingAnchor(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// The short name used in <Term name="...">: the heading without any
// parenthetical expansion.
function slugify(term: string): string {
  return term
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export default {
  watch: [GLOSSARY_FILE],
  load(): GlossaryEntry[] {
    return parseGlossary(readFileSync(GLOSSARY_FILE, 'utf8'))
  },
}

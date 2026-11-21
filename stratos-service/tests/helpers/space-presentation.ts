import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Keypair } from '@atproto/crypto'

export const PRESENTATION_SCHEME = 'Atproto-Space-Credential'
export const PRESENTATION_TAG = 'atproto-space-credential'
export const PRESENTATION_COMPONENTS =
  '("authorization" "atproto-space-audience")'

export interface PresentationVectorCase {
  name: string
  headers: Record<string, string>
  keyId: string
  verdict: { accepted: boolean; error?: string; message?: string }
}

export interface PresentationVectors {
  accepted: {
    authorization: string
    audience: string
    keyId: string
    headers: Record<string, string>
  }
  cases: PresentationVectorCase[]
}

/** Presentation vectors made and judged by the upstream package. */
export const presentationVectors: PresentationVectors = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../test/spaces-alignment/november/fixtures/credential-signature.json',
    ),
    'utf8',
  ),
)

export interface SignedPresentation {
  key: Keypair
  authorization: string
  audience: string
  /** Replaces the default `tag="atproto-space-credential"` parameter list. */
  parameters?: string
  label?: string
}

/** Signs a presentation the way the standard profile asks: tag, any label. */
export async function signPresentation(
  input: SignedPresentation,
): Promise<Record<string, string>> {
  const label = input.label ?? 'sig'
  const parameters =
    input.parameters ?? `${PRESENTATION_COMPONENTS};tag="${PRESENTATION_TAG}"`
  const base = [
    `"authorization": ${input.authorization}`,
    `"atproto-space-audience": ${input.audience}`,
    `"@signature-params": ${parameters}`,
  ].join('\n')
  const signature = await input.key.sign(new TextEncoder().encode(base))
  return {
    authorization: input.authorization,
    'atproto-space-audience': input.audience,
    'signature-input': `${label}=${parameters}`,
    signature: `${label}=:${Buffer.from(signature).toString('base64')}:`,
  }
}

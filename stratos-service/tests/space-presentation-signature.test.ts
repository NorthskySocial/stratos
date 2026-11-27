/**
 * The standard presentation profile: `Atproto-Space-Credential` plus one
 * signature found by its tag, over the credential and the space audience.
 * Every vector was made and judged by the upstream package; the properties
 * cover what generated structured-header dictionaries may and may not do.
 */
import { P256Keypair } from '@atproto/crypto'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  SpaceHttpSignatureError,
  verifySpaceExchangeSignature,
  verifySpacePresentationSignature,
} from '../src/infra/auth/space-http-signature.js'
import {
  PRESENTATION_COMPONENTS,
  PRESENTATION_TAG,
  presentationVectors,
  signPresentation,
} from './helpers/space-presentation.js'

const request = (headers: Record<string, string>) => ({
  rawHeaders: Object.entries(headers).flat(),
})
const AUDIENCE = 'did:web:bebop.example'
const tagged = `${PRESENTATION_COMPONENTS};tag="${PRESENTATION_TAG}"`

const credentialToken = fc.stringMatching(/^[A-Za-z0-9._-]{1,40}$/)
const label = fc.stringMatching(/^[a-z][a-z0-9_-]{0,9}$/)

describe('presentation vectors from the upstream package', () => {
  it.each(presentationVectors.cases)(
    'gives the upstream verdict: $name',
    async ({ headers, keyId, verdict }) => {
      const outcome = verifySpacePresentationSignature(request(headers), {
        keyId,
        expectedAudience: presentationVectors.accepted.audience,
      })
      if (verdict.accepted) await expect(outcome).resolves.toBe(keyId)
      else await expect(outcome).rejects.toBeInstanceOf(SpaceHttpSignatureError)
    },
  )

  it('refuses each vector for the wrong audience', async () => {
    for (const { headers, keyId, verdict } of presentationVectors.cases) {
      if (!verdict.accepted) continue
      await expect(
        verifySpacePresentationSignature(request(headers), {
          keyId,
          expectedAudience: 'did:web:other.example',
        }),
      ).rejects.toMatchObject({ message: 'Incorrect space audience' })
    }
  })
})

describe('presentation signature properties', () => {
  let key: P256Keypair
  beforeAll(async () => {
    key = await P256Keypair.create()
  })
  const binding = () => ({ keyId: key.did(), expectedAudience: AUDIENCE })
  const properties = { numRuns: 25 }

  it('accepts the signature under any label when the tag is right', async () => {
    await fc.assert(
      fc.asyncProperty(credentialToken, label, async (token, name) => {
        const headers = await signPresentation({
          key,
          authorization: `Atproto-Space-Credential ${token}`,
          audience: AUDIENCE,
          label: name,
        })
        await expect(
          verifySpacePresentationSignature(request(headers), binding()),
        ).resolves.toBe(key.did())
      }),
      properties,
    )
  })

  it('refuses when no member carries the tag', async () => {
    await fc.assert(
      fc.asyncProperty(
        credentialToken,
        fc.constantFrom('', ';tag="faye"', ';tag=atproto-space-credential'),
        async (token, parameters) => {
          const headers = await signPresentation({
            key,
            authorization: `Atproto-Space-Credential ${token}`,
            audience: AUDIENCE,
            parameters: `${PRESENTATION_COMPONENTS}${parameters}`,
          })
          await expect(
            verifySpacePresentationSignature(request(headers), binding()),
          ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
        },
      ),
      properties,
    )
  })

  it('refuses when two members carry the tag, whatever their labels', async () => {
    await fc.assert(
      fc.asyncProperty(
        credentialToken,
        fc.tuple(label, label).filter(([first, second]) => first !== second),
        async (token, [first, second]) => {
          const headers = await signPresentation({
            key,
            authorization: `Atproto-Space-Credential ${token}`,
            audience: AUDIENCE,
            label: first,
          })
          const signatureValue = headers.signature.slice(first.length + 1)
          headers['signature-input'] += `, ${second}=${tagged}`
          headers.signature += `, ${second}=${signatureValue}`
          await expect(
            verifySpacePresentationSignature(request(headers), binding()),
          ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
        },
      ),
      properties,
    )
  })

  it('refuses any change to the covered list, even when signed over', async () => {
    const lists = fc.constantFrom(
      '("atproto-space-audience" "authorization")',
      '("authorization")',
      '("atproto-space-audience")',
      '()',
      '("authorization" "atproto-space-audience" "@method")',
      '("authorization" "authorization" "atproto-space-audience")',
      '("authorization";sf "atproto-space-audience")',
    )
    await fc.assert(
      fc.asyncProperty(credentialToken, lists, async (token, covered) => {
        const headers = await signPresentation({
          key,
          authorization: `Atproto-Space-Credential ${token}`,
          audience: AUDIENCE,
          parameters: `${covered};tag="${PRESENTATION_TAG}"`,
        })
        await expect(
          verifySpacePresentationSignature(request(headers), binding()),
        ).rejects.toMatchObject({ message: 'Incorrect covered components' })
      }),
      properties,
    )
  })

  it('accepts an extra parameter only when the signature covers it', async () => {
    const extra = fc.record({
      created: fc.integer({ min: 0, max: 2_000_000_000 }),
      nonce: fc.stringMatching(/^[a-z0-9]{1,12}$/),
    })
    await fc.assert(
      fc.asyncProperty(
        credentialToken,
        extra,
        fc.integer({ min: 1, max: 1000 }),
        async (token, { created, nonce }, drift) => {
          const parameters = `${PRESENTATION_COMPONENTS};created=${created};nonce="${nonce}";tag="${PRESENTATION_TAG}"`
          const headers = await signPresentation({
            key,
            authorization: `Atproto-Space-Credential ${token}`,
            audience: AUDIENCE,
            parameters,
          })
          await expect(
            verifySpacePresentationSignature(request(headers), binding()),
          ).resolves.toBe(key.did())
          const changed = {
            ...headers,
            'signature-input': headers['signature-input'].replace(
              `created=${created}`,
              `created=${created + drift}`,
            ),
          }
          await expect(
            verifySpacePresentationSignature(request(changed), binding()),
          ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
          const dropped = {
            ...headers,
            'signature-input': headers['signature-input'].replace(
              `;nonce="${nonce}"`,
              '',
            ),
          }
          await expect(
            verifySpacePresentationSignature(request(dropped), binding()),
          ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
        },
      ),
      properties,
    )
  })

  it('refuses any change to the authorization bytes after signing, including the case of the scheme', async () => {
    const edits = fc.constantFrom<(value: string) => string>(
      (value) => value.toLowerCase().replace(/^[^ ]+/, (scheme) => scheme),
      (value) =>
        value.replace(/^Atproto-Space-Credential/, 'ATPROTO-SPACE-CREDENTIAL'),
      (value) =>
        value.replace(/^Atproto-Space-Credential/, 'atproto-space-credential'),
      (value) => `${value}x`,
      (value) => value.slice(0, -1),
    )
    await fc.assert(
      fc.asyncProperty(credentialToken, edits, async (token, edit) => {
        const authorization = `Atproto-Space-Credential ${token}`
        const edited = edit(authorization)
        fc.pre(edited !== authorization && /^\S+ \S+$/.test(edited))
        const headers = await signPresentation({
          key,
          authorization,
          audience: AUDIENCE,
        })
        await expect(
          verifySpacePresentationSignature(
            request({ ...headers, authorization: edited }),
            binding(),
          ),
        ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
      }),
      properties,
    )
  })
})

describe('the shape of the Signature member', () => {
  let key: P256Keypair
  beforeAll(async () => {
    key = await P256Keypair.create()
  })
  const binding = () => ({ keyId: key.did(), expectedAudience: AUDIENCE })
  const signed = () =>
    signPresentation({
      key,
      authorization: 'Atproto-Space-Credential nerv-rei',
      audience: AUDIENCE,
    })

  it('accepts the unmodified member', async () => {
    await expect(
      verifySpacePresentationSignature(request(await signed()), binding()),
    ).resolves.toBe(key.did())
  })

  it('refuses a member that is an inner list', async () => {
    const headers = await signed()
    const bytes = headers.signature.slice('sig='.length)
    headers.signature = `sig=(${bytes})`
    await expect(
      verifySpacePresentationSignature(request(headers), binding()),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })

  it('refuses a member that carries parameters', async () => {
    const headers = await signed()
    headers.signature += ';alg="ecdsa-p256-sha256"'
    await expect(
      verifySpacePresentationSignature(request(headers), binding()),
    ).rejects.toMatchObject({
      message: 'Missing or malformed credential-tagged signature',
    })
  })

  it('refuses a tag that sits only on the Signature field', async () => {
    const headers = await signPresentation({
      key,
      authorization: 'Atproto-Space-Credential nerv-rei',
      audience: AUDIENCE,
      parameters: PRESENTATION_COMPONENTS,
    })
    headers.signature += `;tag="${PRESENTATION_TAG}"`
    await expect(
      verifySpacePresentationSignature(request(headers), binding()),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })
})

describe('the two profiles stay apart', () => {
  it('refuses an exchange signature as a presentation and the reverse', async () => {
    const key = await P256Keypair.create()
    const presentation = await signPresentation({
      key,
      authorization: 'Atproto-Space-Credential rei-credential',
      audience: AUDIENCE,
    })
    await expect(
      verifySpaceExchangeSignature(request(presentation)),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)

    const exchange = await signPresentation({
      key,
      authorization: 'Bearer rei-delegation',
      audience: AUDIENCE,
      label: 'atproto-space',
      parameters: `("authorization");keyid="${key.did()}"`,
    })
    await expect(
      verifySpacePresentationSignature(request(exchange), {
        keyId: key.did(),
        expectedAudience: AUDIENCE,
      }),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })

  it('refuses an exchange member that covers the audience as well', async () => {
    const key = await P256Keypair.create()
    const headers = await signPresentation({
      key,
      authorization: 'Bearer rei-delegation',
      audience: AUDIENCE,
      label: 'atproto-space',
      parameters: `${PRESENTATION_COMPONENTS};keyid="${key.did()}"`,
    })
    await expect(
      verifySpaceExchangeSignature(request(headers)),
    ).rejects.toMatchObject({ message: 'Incorrect covered components' })
  })

  it('refuses an exchange member that carries the credential tag', async () => {
    const key = await P256Keypair.create()
    const parameters = `("authorization");keyid="${key.did()}";tag="${PRESENTATION_TAG}"`
    const headers = await signPresentation({
      key,
      authorization: 'Bearer rei-delegation',
      audience: AUDIENCE,
      label: 'atproto-space',
      parameters,
    })
    delete (headers as Record<string, string | undefined>)[
      'atproto-space-audience'
    ]
    // The base above covered the audience line; sign again over authorization only.
    const base = `"authorization": Bearer rei-delegation\n"@signature-params": ${parameters}`
    const signature = await key.sign(new TextEncoder().encode(base))
    headers.signature = `atproto-space=:${Buffer.from(signature).toString('base64')}:`
    await expect(
      verifySpaceExchangeSignature(request(headers)),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })
})

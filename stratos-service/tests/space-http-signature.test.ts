import { P256Keypair, Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import { describe, expect, it } from 'vitest'
import fixtures from './space-http-signature.fixtures.json'
import {
  SpaceHttpSignatureError,
  verifySpaceExchangeSignature,
  verifySpacePresentationSignature,
} from '../src/infra/auth/space-http-signature.js'

const request = (headers: Record<string, string>) => ({
  rawHeaders: Object.entries(headers).flat(),
})
const binding = {
  keyId: fixtures.keyId,
  expectedAudience: 'did:plc:tokyo3',
}
const key = () => P256Keypair.import(new Uint8Array(32).fill(1))

async function signed(input: string, audience?: string, suffix = '') {
  const authorization = audience
    ? 'Atproto-Space misato-credential'
    : 'Bearer rei-delegation'
  const base = [`"authorization": ${authorization}`]
  if (audience) base.push(`"atproto-space-audience": ${audience}`)
  base.push(`"@signature-params": ${input}`)
  const signature = await (
    await key()
  ).sign(new TextEncoder().encode(base.join('\n') + suffix))
  return {
    authorization,
    ...(audience ? { 'atproto-space-audience': audience } : {}),
    'signature-input': `atproto-space=${input}`,
    signature: `atproto-space=:${Buffer.from(signature).toString('base64')}:`,
  }
}

describe('pinned upstream Spaces HTTP signatures', () => {
  it('preserves the public error identity and parser cause', async () => {
    const cause = new Error('rei')
    const error = new SpaceHttpSignatureError('misato', { cause })
    expect(error).toMatchObject({
      message: 'misato',
      name: 'SpaceHttpSignatureError',
      code: 'InvalidSpaceHttpSignature',
      cause,
    })
    await expect(
      verifySpaceExchangeSignature(
        request({ ...fixtures.exchange, signature: '(' }),
      ),
    ).rejects.toMatchObject({
      message: 'Invalid HTTP message signature',
      cause: expect.any(Error),
    })
  })

  it.each([
    ['signature', 'other=:AQ==:', 'Malformed atproto-space signature'],
    [
      'signature',
      'atproto-space=:AQ==:;extra',
      'Malformed atproto-space signature',
    ],
    ['signature', 'atproto-space=(1 2)', 'Malformed atproto-space signature'],
    [
      'signature',
      'atproto-space="not bytes"',
      'Malformed atproto-space signature',
    ],
    [
      'signature-input',
      'atproto-space="authorization"',
      'Malformed atproto-space signature',
    ],
    [
      'signature-input',
      'other=("authorization")',
      'Malformed atproto-space signature',
    ],
    ['authorization', '', 'Missing authorization header'],
    ['signature', '', 'Missing signature header'],
    ['signature-input', '', 'Missing signature-input header'],
  ])(
    'reports the exact malformed field %s %s',
    async (name, value, message) => {
      await expect(
        verifySpaceExchangeSignature(
          request({ ...fixtures.exchange, [name]: value }),
        ),
      ).rejects.toMatchObject({ message })
    },
  )

  it('ignores repeated unrelated headers but rejects malformed and duplicate protected headers', async () => {
    const req = request(fixtures.exchange)
    req.rawHeaders.push('X-Rei', 'nerv', 'X-Rei', 'tokyo3')
    await expect(verifySpaceExchangeSignature(req)).resolves.toBe(
      fixtures.keyId,
    )
    await expect(
      verifySpaceExchangeSignature({ rawHeaders: ['authorization'] }),
    ).rejects.toMatchObject({ message: 'Malformed raw headers' })
    req.rawHeaders.push('Authorization', fixtures.exchange.authorization)
    await expect(verifySpaceExchangeSignature(req)).rejects.toMatchObject({
      message: 'Duplicate signature request header',
    })
  })

  it.each([
    ['Bearer rei-delegation extra', false],
    ['extra Bearer rei-delegation', false],
    ['DPoP rei-delegation', false],
    ['Atproto-Space misato-credential extra', true],
    ['extra Atproto-Space misato-credential', true],
    ['Bearer misato-credential', true],
  ])(
    'rejects a cryptographically valid wrong scheme %s',
    async (authorization, presentation) => {
      const input = presentation
        ? '("authorization" "atproto-space-audience")'
        : `("authorization");keyid="${fixtures.keyId}"`
      const base = [`"authorization": ${authorization}`]
      if (presentation)
        base.push(`"atproto-space-audience": ${binding.expectedAudience}`)
      base.push(`"@signature-params": ${input}`)
      const signature = await (
        await key()
      ).sign(new TextEncoder().encode(base.join('\n')))
      const req = request({
        authorization,
        'signature-input': `atproto-space=${input}`,
        signature: `atproto-space=:${Buffer.from(signature).toString('base64')}:`,
        ...(presentation
          ? { 'atproto-space-audience': binding.expectedAudience }
          : {}),
      })
      await expect(
        presentation
          ? verifySpacePresentationSignature(req, binding)
          : verifySpaceExchangeSignature(req),
      ).rejects.toMatchObject({ message: 'Incorrect authorization scheme' })
    },
  )

  it.each([
    ['("authorization")', 'Signature requires a P-256 did:key'],
    [
      `("authorization");keyid="${fixtures.keyId}";alg="ES256"`,
      'Incorrect signature algorithm',
    ],
    [
      `("authorization";sf);keyid="${fixtures.keyId}"`,
      'Incorrect covered components',
    ],
  ])('reports the profile failure %s', async (input, message) => {
    await expect(
      verifySpaceExchangeSignature(request(await signed(input))),
    ).rejects.toMatchObject({ message })
  })

  it('reports invalid crypto, binding and audience independently', async () => {
    const headers = await signed(
      `("authorization");keyid="${fixtures.keyId}"`,
      undefined,
      '\n',
    )
    await expect(
      verifySpaceExchangeSignature(request(headers)),
    ).rejects.toMatchObject({ message: 'Invalid HTTP message signature' })
    await expect(
      verifySpacePresentationSignature(
        request(
          await signed(
            '("authorization" "atproto-space-audience");keyid="did:key:wrong"',
            binding.expectedAudience,
          ),
        ),
        binding,
      ),
    ).rejects.toMatchObject({
      message: 'Signature keyid does not match credential',
    })
    await expect(
      verifySpacePresentationSignature(request(fixtures.presentation), {
        ...binding,
        expectedAudience: 'did:plc:asuka',
      }),
    ).rejects.toMatchObject({ message: 'Incorrect space audience' })
    await expect(
      verifySpacePresentationSignature(
        request({ ...fixtures.presentation, 'atproto-space-audience': '' }),
        binding,
      ),
    ).rejects.toMatchObject({
      message: 'Missing atproto-space-audience header',
    })
    const curve = await Secp256k1Keypair.create()
    await expect(
      verifySpaceExchangeSignature(
        request(await signed(`("authorization");keyid="${curve.did()}"`)),
      ),
    ).rejects.toMatchObject({ message: 'Signature requires a P-256 did:key' })
  })

  it('verifies upstream-produced exchange and presentation fixtures', async () => {
    expect(fixtures.source).toContain(
      '5b95b2f2723a2882824fbb0b819fd6aad884ef20',
    )
    await expect(
      verifySpaceExchangeSignature(request(fixtures.exchange)),
    ).resolves.toBe(fixtures.keyId)
    await expect(
      verifySpacePresentationSignature(request(fixtures.presentation), binding),
    ).resolves.toBe(fixtures.keyId)
  })

  it('permits presentation reuse without method or URL binding', async () => {
    for (let i = 0; i < 2; i++) {
      await expect(
        verifySpacePresentationSignature(
          request(fixtures.presentation),
          binding,
        ),
      ).resolves.toBe(fixtures.keyId)
    }
  })

  it('canonicalizes structured fields and includes every signature parameter', async () => {
    const input = `("authorization");keyid="${fixtures.keyId}";alg="ecdsa-p256-sha256";created=123;nonce="rei\\\"ayanami";tag="nerv"`
    const headers = await signed(input)
    headers['signature-input'] =
      `other=("@method"), atproto-space=(  "authorization"  )${input.slice(input.indexOf(';'))}`
    headers.signature = `other=:AQ==:, ${headers.signature}`
    headers.authorization = ` \t${headers.authorization}\t `
    await expect(verifySpaceExchangeSignature(request(headers))).resolves.toBe(
      fixtures.keyId,
    )
    headers['signature-input'] = headers['signature-input'].replace(
      'created=123',
      'created=124',
    )
    await expect(
      verifySpaceExchangeSignature(request(headers)),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })

  it('accepts explicit matching presentation keyid and algorithm', async () => {
    const headers = await signed(
      `("authorization" "atproto-space-audience");keyid="${fixtures.keyId}";alg="ecdsa-p256-sha256"`,
      binding.expectedAudience,
    )
    await expect(
      verifySpacePresentationSignature(request(headers), binding),
    ).resolves.toBe(fixtures.keyId)
  })

  it('accepts both compact S forms but does not relax default crypto policy', async () => {
    const signature = Buffer.from(
      fixtures.presentation.signature.slice('atproto-space=:'.length, -1),
      'base64',
    )
    const order = BigInt(
      '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
    )
    const s = BigInt(`0x${signature.subarray(32).toString('hex')}`)
    const low = s < order / 2n ? s : order - s
    for (const value of [low, order - low]) {
      const bytes = Buffer.concat([
        signature.subarray(0, 32),
        Buffer.from(value.toString(16).padStart(64, '0'), 'hex'),
      ])
      await expect(
        verifySpacePresentationSignature(
          request({
            ...fixtures.presentation,
            signature: `atproto-space=:${bytes.toString('base64')}:`,
          }),
          binding,
        ),
      ).resolves.toBe(fixtures.keyId)
      if (value > order / 2n) {
        const base = new TextEncoder().encode(
          `"authorization": Atproto-Space misato-credential\n"atproto-space-audience": did:plc:tokyo3\n"@signature-params": ("authorization" "atproto-space-audience")`,
        )
        expect(await verifySignature(fixtures.keyId, base, bytes)).toBe(false)
      }
    }
  })

  it('rejects a valid DER encoding of an upstream signature', async () => {
    const bytes = Buffer.from(
      fixtures.exchange.signature.slice('atproto-space=:'.length, -1),
      'base64',
    )
    const integer = (part: Buffer) => {
      let hex = BigInt(`0x${part.toString('hex')}`).toString(16)
      if (hex.length % 2) hex = `0${hex}`
      if (parseInt(hex.slice(0, 2), 16) >= 128) hex = `00${hex}`
      return Buffer.concat([
        Buffer.from([2, hex.length / 2]),
        Buffer.from(hex, 'hex'),
      ])
    }
    const body = Buffer.concat([
      integer(bytes.subarray(0, 32)),
      integer(bytes.subarray(32)),
    ])
    const der = Buffer.concat([Buffer.from([48, body.length]), body])
    await expect(
      verifySpaceExchangeSignature(
        request({
          ...fixtures.exchange,
          signature: `atproto-space=:${der.toString('base64')}:`,
        }),
      ),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })

  it.each([
    'authorization',
    'atproto-space-audience',
    'signature',
    'signature-input',
  ])('rejects raw duplicate %s regardless of casing', async (name) => {
    const req = request(fixtures.presentation)
    req.rawHeaders.push(
      name.toUpperCase(),
      fixtures.presentation[name as keyof typeof fixtures.presentation],
    )
    await expect(
      verifySpacePresentationSignature(req, binding),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })

  it.each([
    ['authorization', 'Bearer changed'],
    ['authorization', 'DPoP rei-delegation'],
    ['authorization', ''],
    ['signature', 'other=:AQ==:'],
    ['signature', 'atproto-space=:AQ==:;extra'],
    ['signature', 'atproto-space=(1 2)'],
    ['signature', 'atproto-space="not bytes"'],
    ['signature', 'atproto-space=:!!!:'],
    ['signature-input', 'atproto-space="authorization"'],
    ['signature-input', 'atproto-space=("authorization"'],
    ['signature-input', 'other=("authorization")'],
    ['signature-input', '(broken'],
  ])('rejects malformed or changed exchange %s %s', async (name, value) => {
    await expect(
      verifySpaceExchangeSignature(
        request({ ...fixtures.exchange, [name]: value }),
      ),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })

  it.each([
    '("authorization")',
    '("authorization");keyid=42',
    '("authorization");keyid="did:key:broken"',
    `("authorization");keyid="${fixtures.keyId}";alg="ES256"`,
    `("authorization";sf);keyid="${fixtures.keyId}"`,
    `("@method" "authorization");keyid="${fixtures.keyId}"`,
  ])('rejects invalid exchange profile %s', async (input) => {
    await expect(
      verifySpaceExchangeSignature(request(await signed(input))),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })

  it.each([
    '("atproto-space-audience" "authorization")',
    '("authorization")',
    '("authorization" "atproto-space-audience" "@method")',
    '("authorization" "atproto-space-audience");keyid="did:key:wrong"',
    '("authorization" "atproto-space-audience");alg="ES256"',
  ])('rejects invalid presentation profile %s', async (input) => {
    await expect(
      verifySpacePresentationSignature(
        request(await signed(input, binding.expectedAudience)),
        binding,
      ),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })

  it('rejects wrong keys, curves, audience and profile cross-use', async () => {
    const wrongKey = await P256Keypair.create()
    const wrongCurve = await Secp256k1Keypair.create()
    for (const keyId of [
      wrongKey.did(),
      wrongCurve.did(),
      'did:key:broken',
      '',
    ]) {
      await expect(
        verifySpacePresentationSignature(request(fixtures.presentation), {
          ...binding,
          keyId,
        }),
      ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
    }
    await expect(
      verifySpaceExchangeSignature(
        request(await signed(`("authorization");keyid="${wrongCurve.did()}"`)),
      ),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
    for (const expectedAudience of ['', 'did:plc:asuka']) {
      await expect(
        verifySpacePresentationSignature(request(fixtures.presentation), {
          ...binding,
          expectedAudience,
        }),
      ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
    }
    await expect(
      verifySpaceExchangeSignature(request(fixtures.presentation)),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
    await expect(
      verifySpacePresentationSignature(request(fixtures.exchange), binding),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })

  it('rejects missing headers, changed audience and trailing LF', async () => {
    for (const name of Object.keys(fixtures.presentation)) {
      const headers: Record<string, string> = { ...fixtures.presentation }
      delete headers[name]
      await expect(
        verifySpacePresentationSignature(request(headers), binding),
      ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
    }
    await expect(
      verifySpacePresentationSignature(
        request({
          ...fixtures.presentation,
          'atproto-space-audience': 'did:plc:asuka',
        }),
        binding,
      ),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
    await expect(
      verifySpaceExchangeSignature({ rawHeaders: ['authorization'] }),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
    const headers = await signed(
      `("authorization");keyid="${fixtures.keyId}"`,
      undefined,
      '\n',
    )
    await expect(
      verifySpaceExchangeSignature(request(headers)),
    ).rejects.toBeInstanceOf(SpaceHttpSignatureError)
  })
})

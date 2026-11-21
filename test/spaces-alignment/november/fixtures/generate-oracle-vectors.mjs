// Writes the fixtures next to this file from the published upstream packages.
//
// usage: node generate-oracle-vectors.mjs <oracle-directory> [--tokens]
//                                          [--stratos-produced]
//                                          [--commit-mac] [--kem-keys]
//
// Without a flag every file but token-audiences.json, stratos-produced.json,
// commit-mac.json and kem-keys.json is written, and the output is the same on
// every run. token-audiences.json holds tokens the oracle stamps with the clock
// and a random jti, so it is written only with --tokens and then kept.
// stratos-produced.json takes its inputs from constants copied out of Stratos
// tests (named beside each one) and is written only with --stratos-produced.
// commit-mac.json and kem-keys.json are reproducible and each has its own flag.
//
// Every file's header pins this generator's hash. Changing this file means
// running again, and a file that is not rewritten has to have that one header
// line updated by hand.
//
// The oracle directory is a standalone install of the exact package named
// below, outside this repository, and also holds the RFC vector file as
// hpke-test-vectors.json (pinned by hash below). Expected bytes come from that
// package or from the RFC entry, never from Stratos code. No network, clock or
// randomness: every key and input is fixed here.
import { ECDH, createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GENERATOR_PATH =
  'test/spaces-alignment/november/fixtures/generate-oracle-vectors.mjs'

const ORACLE_PACKAGE = '@atproto/space'
const ORACLE_VERSION = '0.0.0-spaces-alpha-20261117141222'
const ORACLE_INTEGRITY =
  'sha512-AasGxXJz1htNRNNR1JL/2v4EV45VvC4UrbY1x/w/cFH0avOHFxhDV0MQMMegVYhSi7DtnkJ1smwDxO6K/W402g=='

const RFC_SOURCE = {
  source: 'RFC 9180 test vectors (CFRG HPKE)',
  url: 'https://raw.githubusercontent.com/cfrg/draft-irtf-cfrg-hpke/b1f7cb0cdeab6906c61b3d6574e8bdfdbe1cd3fb/test-vectors.json',
  commit: 'b1f7cb0cdeab6906c61b3d6574e8bdfdbe1cd3fb',
  sha256: '61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6',
}

// Test-only keys. They protect nothing and exist only to make vectors fixed.
const TEST_ONLY_SIGNER_KEY = '11'.repeat(32)
const TEST_ONLY_OTHER_SIGNER_KEY = '44'.repeat(32)
const TEST_ONLY_AUTHOR_KEM_KEY = '22'.repeat(32)
const TEST_ONLY_EPHEMERAL_KEY = '33'.repeat(32)

const AUDIENCE = 'did:web:bebop.example'
const AUTHORIZATION = 'Atproto-Space-Credential spike-spiegel-test-credential'
const REPO = 'did:plc:fayevalentine'
const LEGACY_SPACE =
  'at://did:web:bebop.example/space/zone.stratos.space.feed/crew'
const POST = 'zone.stratos.feed.post'
const LIKE = 'app.bsky.feed.like'
const REPOST = 'app.bsky.feed.repost'
const REVISIONS = [
  '3jzfcijpj2z2a',
  '3jzfcijpj2z2b',
  '3jzfcijpj2z2c',
  '3jzfcijpj2z2d',
]

const oracleDirectory = process.argv[2]
const flags = process.argv.slice(3)
const writeTokens = flags.includes('--tokens')
const writeStratosProduced = flags.includes('--stratos-produced')
const writeCommitMac = flags.includes('--commit-mac')
const writeKemKeys = flags.includes('--kem-keys')
const KNOWN_FLAGS = [
  '--tokens',
  '--stratos-produced',
  '--commit-mac',
  '--kem-keys',
]
if (!oracleDirectory || flags.some((flag) => !KNOWN_FLAGS.includes(flag))) {
  console.error(
    `usage: node generate-oracle-vectors.mjs <oracle-directory> [${KNOWN_FLAGS.join('] [')}]`,
  )
  process.exit(2)
}

const spaceEntry = realpathSync(
  resolve(oracleDirectory, 'node_modules/@atproto/space/dist/index.js'),
)
const spaceRequire = createRequire(spaceEntry)
const importFrom = (specifier) =>
  import(pathToFileURL(spaceRequire.resolve(specifier)).href)

const space = await import(pathToFileURL(spaceEntry).href)
const { P256Keypair } = await importFrom('@atproto/crypto')

const installed = JSON.parse(
  readFileSync(resolve(dirname(dirname(spaceEntry)), 'package.json'), 'utf8'),
)
if (installed.version !== ORACLE_VERSION) {
  throw new Error(`oracle is ${installed.version}, expected ${ORACLE_VERSION}`)
}

const generatorSha256 = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex')

const oracle = {
  package: ORACLE_PACKAGE,
  version: ORACLE_VERSION,
  integrity: ORACLE_INTEGRITY,
}
const generator = { path: GENERATOR_PATH, sha256: generatorSha256 }

const bytesField = (bytes, encoding = 'base64') => ({
  encoding,
  value: Buffer.from(bytes).toString(encoding),
  length: bytes.length,
})

const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'))

// Lays JSON out as prettier does (short primitive arrays on one line) so the
// committed bytes are exactly what this generator writes. A value wrapped in
// inlineIfShort stays on one line when it fits, as prettier keeps an object
// written on one line; nothing else is collapsed.
const PRINT_WIDTH = 80
class InlineIfShort {
  constructor(value) {
    this.value = value
  }
}
const inlineIfShort = (value) => new InlineIfShort(value)
const flat = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(flat).join(', ')}]`
  const entries = Object.entries(value).map(
    ([key, child]) => `${JSON.stringify(key)}: ${flat(child)}`,
  )
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`
}
// trailing is the width of the comma that follows the value, if any.
const layout = (value, indent, prefixWidth, trailing = 0) => {
  if (value instanceof InlineIfShort) {
    const line = flat(value.value)
    if (indent + prefixWidth + line.length + trailing <= PRINT_WIDTH)
      return line
    return layout(value.value, indent, prefixWidth, trailing)
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const pad = ' '.repeat(indent + 2)
  const close = ' '.repeat(indent)
  const commaAfter = (index, count) => (index < count - 1 ? 1 : 0)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const primitive = value.every(
      (item) => item === null || typeof item !== 'object',
    )
    if (primitive) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
      if (indent + prefixWidth + inline.length + trailing <= PRINT_WIDTH)
        return inline
    }
    const items = value.map(
      (item, index) =>
        `${pad}${layout(item, indent + 2, 0, commaAfter(index, value.length))}`,
    )
    return `[\n${items.join(',\n')}\n${close}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const lines = entries.map(([key, child], index) => {
    const head = `${JSON.stringify(key)}: `
    const after = commaAfter(index, entries.length)
    return `${pad}${head}${layout(child, indent + 2, head.length, after)}`
  })
  return `{\n${lines.join(',\n')}\n${close}}`
}

const writeFixture = (name, header, body) => {
  writeFileSync(resolve(HERE, name), `${layout({ header, ...body }, 0, 0)}\n`)
}

const verdictOf = async (run) => {
  try {
    await run()
    return { accepted: true }
  } catch (error) {
    return { accepted: false, error: error.name, message: error.message }
  }
}

const signer = await P256Keypair.import(fromHex(TEST_ONLY_SIGNER_KEY))
const otherSigner = await P256Keypair.import(
  fromHex(TEST_ONLY_OTHER_SIGNER_KEY),
)
const { headers: signedHeaders } = await space.createSpaceSigHeaders({
  authorization: AUTHORIZATION,
  audience: AUDIENCE,
  keypair: signer,
})
const tag = 'atproto-space-credential'
const input = signedHeaders['signature-input']
const signatureField = signedHeaders['signature']
const withHeaders = (changes) => ({ ...signedHeaders, ...changes })
const relabel = (value, label) => value.replace(/^sig=/, `${label}=`)

// The oracle only signs the bare profile, so cases that add parameters are
// signed here over the RFC 9421 base and then judged by the oracle verifier.
const COMPONENTS = '("authorization" "atproto-space-audience")'
const signWithParameters = async (keypair, parameters, authorization) => {
  const params = `${COMPONENTS}${parameters}`
  const base = [
    `"authorization": ${authorization}`,
    `"atproto-space-audience": ${AUDIENCE}`,
    `"@signature-params": ${params}`,
  ].join('\n')
  const signature = await keypair.sign(new TextEncoder().encode(base))
  return {
    'signature-input': `sig=${params}`,
    signature: `sig=:${Buffer.from(signature).toString('base64')}:`,
  }
}
const parametersCase = async (name, parameters, keyId = signer.did()) => ({
  name,
  headers: withHeaders(
    await signWithParameters(signer, parameters, AUTHORIZATION),
  ),
  keyId,
})
const mixedCaseAuthorization =
  'aTpRoTo-SpAcE-CrEdEnTiAl spike-spiegel-test-credential'
const { headers: mixedCaseHeaders } = await space.createSpaceSigHeaders({
  authorization: mixedCaseAuthorization,
  audience: AUDIENCE,
  keypair: signer,
})
const otherTagSignature = await signWithParameters(
  otherSigner,
  ';tag="faye-valentine-test"',
  AUTHORIZATION,
)

const credentialCases = [
  ['accepted as signed', signedHeaders, signer.did()],
  [
    'accepted under another label with the right tag',
    withHeaders({
      'signature-input': relabel(input, 'faye'),
      signature: relabel(signatureField, 'faye'),
    }),
    signer.did(),
  ],
  [
    'two signatures carry the tag',
    withHeaders({
      'signature-input': `${input}, ${relabel(input, 'faye')}`,
      signature: `${signatureField}, ${relabel(signatureField, 'faye')}`,
    }),
    signer.did(),
  ],
  [
    'no signature carries the tag',
    withHeaders({ 'signature-input': input.replace(`;tag="${tag}"`, '') }),
    signer.did(),
  ],
  [
    'components reordered',
    withHeaders({
      'signature-input': input.replace(
        '("authorization" "atproto-space-audience")',
        '("atproto-space-audience" "authorization")',
      ),
    }),
    signer.did(),
  ],
  [
    'an extra component',
    withHeaders({
      'signature-input': input.replace(
        '"atproto-space-audience")',
        '"atproto-space-audience" "content-type")',
      ),
    }),
    signer.did(),
  ],
  ['verified against the wrong key', signedHeaders, otherSigner.did()],
  [
    'authorization value altered',
    withHeaders({
      authorization: 'Atproto-Space-Credential jet-black-test-credential',
    }),
    signer.did(),
  ],
]

const parameterCases = [
  await parametersCase(
    'a created parameter',
    `;created=909187200;tag="${tag}"`,
  ),
  await parametersCase(
    'keyid equal to the key',
    `;keyid="${signer.did()}";tag="${tag}"`,
  ),
  await parametersCase(
    'keyid of another key',
    `;keyid="${otherSigner.did()}";tag="${tag}"`,
  ),
  await parametersCase(
    'alg ecdsa-p256-sha256',
    `;alg="ecdsa-p256-sha256";tag="${tag}"`,
  ),
  await parametersCase('another alg', `;alg="ed25519";tag="${tag}"`),
]
credentialCases.push(
  ['scheme in mixed case, signed as written', mixedCaseHeaders, signer.did()],
  ...parameterCases.map((c) => [c.name, c.headers, c.keyId]),
  [
    'a second signature with another tag beside the right one',
    withHeaders({
      'signature-input': `${input}, other=${COMPONENTS};tag="faye-valentine-test"`,
      signature: `${signatureField}, other=${otherTagSignature.signature.replace(/^sig=/, '')}`,
    }),
    signer.did(),
  ],
)

const credentialResults = []
for (const [name, headers, keyId] of credentialCases) {
  credentialResults.push({
    name,
    headers,
    keyId,
    verdict: await verdictOf(() => space.verifyCredentialSig(headers, keyId)),
  })
}
const signatureBytes = Buffer.from(
  /:([A-Za-z0-9+/=]+):/.exec(signatureField)[1],
  'base64',
)

writeFixture(
  'credential-signature.json',
  {
    classification: 'upstream-uri-free',
    oracle,
    generator,
    upstreamVerified: true,
    reproducible: true,
  },
  {
    testOnlyKeys: {
      signerDid: signer.did(),
      otherSignerDid: otherSigner.did(),
    },
    profile: {
      label: 'sig',
      tag,
      components: ['authorization', 'atproto-space-audience'],
      alg: 'ecdsa-p256-sha256',
    },
    accepted: {
      authorization: AUTHORIZATION,
      audience: AUDIENCE,
      keyId: signer.did(),
      headers: signedHeaders,
      signature: bytesField(signatureBytes),
    },
    cases: credentialResults,
  },
)

const records = {
  swordfishV1: await space.serializeRecord(POST, 'swordfish', {
    $type: POST,
    text: 'See you space cowboy',
    createdAt: '1998-10-24T00:00:00.000Z',
  }),
  swordfishV2: await space.serializeRecord(POST, 'swordfish', {
    $type: POST,
    text: 'See you space cowboy, edited',
    createdAt: '1998-10-24T00:00:00.000Z',
  }),
  like: await space.serializeRecord(LIKE, 'ed', {
    $type: LIKE,
    subject: {
      uri: `${LEGACY_SPACE}/${REPO}/${POST}/swordfish`,
      cid: 'bafyreih2',
    },
    createdAt: '1998-10-25T00:00:00.000Z',
  }),
  ein: await space.serializeRecord(POST, 'ein', {
    $type: POST,
    text: 'Bark',
    createdAt: '1998-10-26T00:00:00.000Z',
  }),
  repost: await space.serializeRecord(REPOST, 'jet', {
    $type: REPOST,
    subject: {
      uri: `${LEGACY_SPACE}/${REPO}/${POST}/swordfish`,
      cid: 'bafyreih2',
    },
    createdAt: '1998-10-27T00:00:00.000Z',
  }),
}
const decodeValue = async (serialized) => {
  const { decode } = await importFrom('@atproto/lex-cbor')
  return decode(serialized.bytes)
}
const toJson = (value) =>
  JSON.parse(
    JSON.stringify(value, (_k, v) =>
      v instanceof Uint8Array
        ? { $bytes: Buffer.from(v).toString('base64').replace(/=+$/, '') }
        : v,
    ),
  )

const [r1, r2, r3, r4] = REVISIONS
const ops = [
  {
    rev: r1,
    ...path(records.swordfishV1),
    cid: records.swordfishV1.cid,
    prev: null,
    value: records.swordfishV1,
  },
  {
    rev: r2,
    ...path(records.swordfishV2),
    cid: records.swordfishV2.cid,
    prev: records.swordfishV1.cid,
    value: records.swordfishV2,
  },
  {
    rev: r2,
    ...path(records.like),
    cid: records.like.cid,
    prev: null,
    value: records.like,
  },
  {
    rev: r3,
    ...path(records.ein),
    cid: records.ein.cid,
    prev: null,
    value: records.ein,
  },
  { rev: r4, ...path(records.ein), cid: null, prev: records.ein.cid },
]
function path(serialized) {
  return { collection: serialized.collection, rkey: serialized.rkey }
}

const repoCommit = new space.RepoCommit().applyOps(
  ops.map(({ collection, rkey, cid, prev }) => ({
    collection,
    rkey,
    cid,
    prev,
  })),
)
const commit = repoCommit.toCommit({ space: LEGACY_SPACE, repo: REPO, rev: r4 })

const pageOps = []
for (const op of ops) {
  const entry = {
    rev: op.rev,
    collection: op.collection,
    rkey: op.rkey,
    cid: op.cid === null ? null : op.cid.toString(),
    prev: op.prev === null ? null : op.prev.toString(),
  }
  if (op.value) entry.value = toJson(await decodeValue(op.value))
  pageOps.push(entry)
}

const authorKem = await P256Keypair.import(fromHex(TEST_ONLY_AUTHOR_KEM_KEY))
const ephemeral = await P256Keypair.import(fromHex(TEST_ONLY_EPHEMERAL_KEY))
const keyShare = ephemeral.did()
const sharedSecret = space.decapsulate(authorKem, keyShare)
const macRequestHeader = space.formatMacRequest(
  space.COMMIT_MAC_PROFILE,
  keyShare,
)
const macRequest = space.parseMacRequest(
  macRequestHeader,
  space.COMMIT_MAC_PROFILE,
)
const { headers: macHeaders } = space.createCommitMacHeaders(commit, {
  ...macRequest,
  sharedSecret,
})
await space.verifyCommitMac(commit, {
  keyShare,
  sharedSecret,
  headers: new Headers(macHeaders),
})
const macBytes = Buffer.from(
  /:([A-Za-z0-9+/=]+):/.exec(macHeaders.signature)[1],
  'base64',
)
const tamperedHeaders = {
  ...macHeaders,
  'atproto-space-commit': macHeaders['atproto-space-commit'].replace(
    `rev="${r4}"`,
    `rev="${r3}"`,
  ),
}
const tamperedVerdict = await verdictOf(() =>
  space.verifyCommitMac(commit, {
    keyShare,
    sharedSecret,
    headers: new Headers(tamperedHeaders),
  }),
)

writeFixture(
  'commit-and-ops.json',
  {
    classification: 'upstream-legacy-uri',
    oracle,
    generator,
    upstreamVerified: true,
    reproducible: true,
  },
  {
    note: 'The space field is the legacy serialization the pinned upstream emits.',
    page: {
      ops: pageOps,
      commit: {
        ver: commit.ver,
        repo: commit.repo,
        space: commit.space,
        rev: commit.rev,
        data: {
          $bytes: Buffer.from(commit.data)
            .toString('base64')
            .replace(/=+$/, ''),
        },
      },
    },
    commitDataDigest: bytesField(commit.data),
    macRequest: {
      testOnlyKeyShareDid: keyShare,
      acceptSignature: macRequestHeader,
      sharedSecret: bytesField(sharedSecret),
    },
    macResponse: {
      headers: macHeaders,
      mac: bytesField(macBytes),
      verdict: { accepted: true },
      tamperedRevision: { headers: tamperedHeaders, verdict: tamperedVerdict },
    },
  },
)

const rfcVectors = JSON.parse(
  readFileSync(resolve(oracleDirectory, 'hpke-test-vectors.json'), 'utf8'),
)
const rfcEntries = rfcVectors.filter(
  (entry) =>
    entry.mode === 0 &&
    entry.kem_id === 0x0010 &&
    entry.kdf_id === 0x0001 &&
    entry.aead_id === 0xffff,
)
if (rfcEntries.length !== 1)
  throw new Error('expected one export-only P-256 entry')
if (
  createHash('sha256')
    .update(readFileSync(resolve(oracleDirectory, 'hpke-test-vectors.json')))
    .digest('hex') !== RFC_SOURCE.sha256
) {
  throw new Error('RFC vector file hash differs from the pinned one')
}

writeFixture(
  'hpke-export-rfc.json',
  {
    classification: 'rfc',
    oracle: RFC_SOURCE,
    generator,
    upstreamVerified: false,
    reproducible: true,
  },
  { rfcEntry: rfcEntries[0] },
)

writeFixture(
  'hpke-export-oracle.json',
  {
    classification: 'upstream-uri-free',
    oracle,
    generator,
    upstreamVerified: true,
    reproducible: true,
  },
  {
    note: 'The keys in oracleExport are fixed, test-only values and protect nothing.',
    oracleExport: {
      info: 'atproto-mac',
      authorKemPrivateKey: bytesField(fromHex(TEST_ONLY_AUTHOR_KEM_KEY), 'hex'),
      authorKemDid: authorKem.did(),
      ephemeralPrivateKey: bytesField(fromHex(TEST_ONLY_EPHEMERAL_KEY), 'hex'),
      keyShareDid: keyShare,
      sharedSecret: bytesField(sharedSecret),
    },
  },
)

const element = (serialized) =>
  `${serialized.collection}/${serialized.rkey}/${serialized.cid.toString()}`
const elements = [
  records.swordfishV2,
  records.like,
  records.repost,
  records.ein,
].map(element)
const hashOf = (list) =>
  list.reduce((hash, item) => hash.add(item), new space.LtHash())
const all = hashOf(elements)
const reordered = hashOf([...elements].reverse())
const removed = hashOf(elements).remove(elements[3])
const empty = new space.LtHash()

writeFixture(
  'lthash.json',
  {
    classification: 'upstream-uri-free',
    oracle,
    generator,
    upstreamVerified: true,
    reproducible: true,
  },
  {
    elementFormat: '{collection}/{rkey}/{cid}',
    elements,
    emptyDigest: bytesField(empty.digest()),
    stateAll: bytesField(all.state()),
    digestAll: bytesField(all.digest()),
    stateReordered: bytesField(reordered.state()),
    digestReordered: bytesField(reordered.digest()),
    removedElement: elements[3],
    stateAfterRemove: bytesField(removed.state()),
    digestAfterRemove: bytesField(removed.digest()),
  },
)

const starCommit = new space.RepoCommit()
  .add(records.like.collection, records.like.rkey, records.like.cid)
  .add(
    records.swordfishV2.collection,
    records.swordfishV2.rkey,
    records.swordfishV2.cid,
  )
  .toCommit({ space: LEGACY_SPACE, repo: REPO, rev: r2 })
const sortedRecords = [records.like, records.swordfishV2]
const chunks = []
for await (const chunk of space.writeRepoStar(starCommit, sortedRecords))
  chunks.push(chunk)
const archive = Buffer.concat(chunks)

const readVerdict = (bytes) =>
  verdictOf(async () => {
    const repo = await space.readRepoStar([bytes])
    for await (const record of repo.records) void record
  })

writeFixture(
  'star-framing.json',
  {
    classification: 'upstream-legacy-uri',
    oracle,
    generator,
    upstreamVerified: true,
    reproducible: true,
  },
  {
    framing: {
      magicHex: '2a6c0100',
      pairControlHex: '01',
      endControlHex: '00',
      layout: '[magic | len | meta] [01 | len | key | len | value]... [00]',
    },
    meta: {
      $type: 'atproto-space-repo',
      ...toJson({ ...starCommit, data: starCommit.data }),
    },
    recordPaths: sortedRecords.map((r) => `${r.collection}/${r.rkey}`),
    archive: bytesField(archive),
    archiveVerdict: await readVerdict(archive),
    negatives: [
      {
        name: 'cut short before the end marker',
        archive: bytesField(archive.subarray(0, archive.length - 1)),
        verdict: await readVerdict(archive.subarray(0, archive.length - 1)),
      },
      {
        name: 'invalid control byte where the end marker belongs',
        archive: bytesField(
          Buffer.concat([
            archive.subarray(0, archive.length - 1),
            Buffer.from([2]),
          ]),
        ),
        verdict: await readVerdict(
          Buffer.concat([
            archive.subarray(0, archive.length - 1),
            Buffer.from([2]),
          ]),
        ),
      },
      {
        name: 'bytes after the end marker',
        archive: bytesField(Buffer.concat([archive, Buffer.from([0])])),
        verdict: await readVerdict(Buffer.concat([archive, Buffer.from([0])])),
      },
    ],
  },
)

writeFixture(
  'target-uri-cases.json',
  {
    classification: 'target-uri-synthetic',
    oracle: {
      note: 'Written by hand from the chosen at:space/ grammar; no upstream artifact produces these strings yet.',
    },
    generator: 'hand-derived',
    upstreamVerified: false,
    reproducible: true,
  },
  {
    cases: [
      {
        name: 'a space',
        uri: 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew',
        components: {
          authority: 'did:web:bebop.example',
          spaceType: 'zone.stratos.space.feed',
          skey: 'crew',
        },
      },
      {
        name: 'a record whose author differs from the authority',
        uri: 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew/did:plc:fayevalentine/zone.stratos.feed.post/swordfish',
        components: {
          authority: 'did:web:bebop.example',
          spaceType: 'zone.stratos.space.feed',
          skey: 'crew',
          author: 'did:plc:fayevalentine',
          collection: 'zone.stratos.feed.post',
          rkey: 'swordfish',
        },
      },
      {
        name: 'a did:web authority with an encoded port',
        uri: 'at:space/did:web:localhost%3A3100/zone.stratos.space.feed/nerv',
        components: {
          authority: 'did:web:localhost%3A3100',
          spaceType: 'zone.stratos.space.feed',
          skey: 'nerv',
        },
      },
    ],
  },
)

if (writeTokens) {
  const { Secp256k1Keypair } = await importFrom('@atproto/crypto')
  const AUTHORITY = 'did:web:bebop.example'
  const MEMBER = 'did:plc:fayevalentine'
  const CLIENT_ID = 'https://redhawk.example/client-metadata.json'
  const CLIENT_KEY_ID = 'ein-test-key-1'
  const SPACE_URI = `at:space/${AUTHORITY}/zone.stratos.space.feed/crew`
  const RETIRED_AUDIENCE = `${AUTHORITY}#atproto_space_host`

  // Test-only keys: protect nothing, fix the signatures.
  const keyOf = (hex) => P256Keypair.import(fromHex(hex))
  const memberKey = await keyOf('77'.repeat(32))
  const authorityKey = await keyOf('88'.repeat(32))
  const holderKey = await keyOf('55'.repeat(32))
  const clientKey = await keyOf('66'.repeat(32))
  const otherAuthorityKey = await keyOf('99'.repeat(32))
  const secpKey = await Secp256k1Keypair.import(fromHex('aa'.repeat(32)))

  const audience = space.spaceHostAud(AUTHORITY)
  const part = (jwt, index) =>
    JSON.parse(Buffer.from(jwt.split('.')[index], 'base64url').toString())
  const b64url = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const resign = async (jwt, keypair, change) => {
    const header = part(jwt, 0)
    const payload = part(jwt, 1)
    change({ header, payload })
    const signingInput = `${b64url(header)}.${b64url(payload)}`
    const signature = await keypair.sign(new TextEncoder().encode(signingInput))
    return `${signingInput}.${Buffer.from(signature).toString('base64url')}`
  }

  // Compact on purpose: the fixtures share a size budget. The oracle's error
  // code is the stable part of a refusal.
  const tokenVerdict = async (run) => {
    try {
      await run()
      return 'accepted'
    } catch (error) {
      return `refused: ${error.code}`
    }
  }
  const clockedVerdict = async (clockSeconds, run) => {
    const realNow = Date.now
    Date.now = () => clockSeconds * 1000
    try {
      return await tokenVerdict(run)
    } finally {
      Date.now = realNow
    }
  }
  const publicJwk = (keypair, kid) => {
    const point = ECDH.convertKey(
      Buffer.from(keypair.publicKeyBytes()),
      'prime256v1',
      undefined,
      undefined,
      'uncompressed',
    )
    return {
      kty: 'EC',
      crv: 'P-256',
      kid,
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33).toString('base64url'),
    }
  }

  const describeToken = async (name, type, jwt, keypair, options) => {
    const payload = part(jwt, 1)
    const frozenClockSeconds = payload.iat
    return {
      name,
      token: jwt,
      frozenClockSeconds,
      verdicts: {
        parse: await tokenVerdict(() => space.parseSpaceToken(type, jwt)),
        verify: await clockedVerdict(frozenClockSeconds, () =>
          space.verifySpaceToken(type, jwt, {
            getSigningKey: () => keypair.did(),
            ...options,
          }),
        ),
      },
    }
  }

  const delegation = await space.createDelegationToken({
    iss: MEMBER,
    sub: SPACE_URI,
    aud: audience,
    keypair: memberKey,
  })
  const retiredDelegation = await space.createDelegationToken({
    iss: MEMBER,
    sub: SPACE_URI,
    aud: RETIRED_AUDIENCE,
    keypair: memberKey,
  })
  const attestation = await space.createClientAttestation({
    clientId: CLIENT_ID,
    aud: audience,
    kid: CLIENT_KEY_ID,
    keypair: clientKey,
  })
  const credential = await space.createSpaceCredential({
    iss: AUTHORITY,
    sub: SPACE_URI,
    keyId: holderKey.did(),
    keypair: authorityKey,
  })

  const credentialOptions = { sub: SPACE_URI }
  const credentialVariant = (name, keypair, change) =>
    resign(credential, keypair, change).then((jwt) =>
      describeToken(name, 'credential', jwt, authorityKey, credentialOptions),
    )

  const tokens = [
    await describeToken('delegation', 'delegation', delegation, memberKey, {
      aud: audience,
      sub: SPACE_URI,
    }),
    await describeToken(
      'delegation with the retired audience',
      'delegation',
      retiredDelegation,
      memberKey,
      { aud: audience, sub: SPACE_URI },
    ),
    await describeToken(
      'client attestation',
      'clientAttestation',
      attestation,
      clientKey,
      { aud: audience },
    ),
    await describeToken(
      'credential',
      'credential',
      credential,
      authorityKey,
      credentialOptions,
    ),
    await credentialVariant(
      'credential without kid',
      authorityKey,
      ({ header }) => {
        delete header.kid
      },
    ),
    await credentialVariant(
      'credential with another kid',
      authorityKey,
      ({ header }) => {
        header.kid = '#atproto_other'
      },
    ),
    await credentialVariant(
      'credential with an aud claim',
      authorityKey,
      ({ payload }) => {
        payload.aud = audience
      },
    ),
    await credentialVariant(
      'credential with alg none',
      authorityKey,
      ({ header }) => {
        header.alg = 'none'
      },
    ),
    await credentialVariant(
      'credential bound to a non-P-256 key',
      authorityKey,
      ({ payload }) => {
        payload.cnf = { kid: secpKey.did() }
      },
    ),
    await credentialVariant(
      'credential without cnf',
      authorityKey,
      ({ payload }) => {
        delete payload.cnf
      },
    ),
    await credentialVariant(
      'credential signed by another key',
      otherAuthorityKey,
      () => {},
    ),
  ]
  writeFixture(
    'token-audiences.json',
    {
      classification: 'upstream-signed-target-uri',
      oracle,
      generator,
      upstreamVerified: true,
      reproducible: false,
      reproducibleReason:
        'The oracle stamps the clock and a random jti into each token. Stored once; tests freeze the clock to frozenClockSeconds.',
    },
    {
      note: 'upstreamVerified is the oracle verdict. sub holds a hand-written at:space/ uri as an opaque claim.',
      authority: AUTHORITY,
      audience,
      spaceUri: SPACE_URI,
      testOnlyKeys: {
        memberDid: memberKey.did(),
        authorityDid: authorityKey.did(),
        holderDid: holderKey.did(),
        clientDid: clientKey.did(),
        clientKeyId: CLIENT_KEY_ID,
        clientJwk: publicJwk(clientKey, CLIENT_KEY_ID),
      },
      tokens,
    },
  )
}

if (writeStratosProduced) {
  const { Secp256k1Keypair } = await importFrom('@atproto/crypto')
  const accepted = 'accepted'
  const verdictCode = async (run) => {
    try {
      await run()
      return accepted
    } catch (error) {
      return `refused: ${error.code ?? error.name}`
    }
  }
  const atClock = async (clockSeconds, run) => {
    const realNow = Date.now
    Date.now = () => clockSeconds * 1000
    try {
      return await verdictCode(run)
    } finally {
      Date.now = realNow
    }
  }
  const judgeToken = async (type, token, clockSeconds, signerDid, options) => ({
    parse: await verdictCode(() => space.parseSpaceToken(type, token)),
    verify: await atClock(clockSeconds, () =>
      space.verifySpaceToken(type, token, {
        getSigningKey: () => signerDid,
        ...options,
      }),
    ),
  })

  // Copied from the Rust test `presentation_headers_are_the_pinned_strings`
  // in stratos-feedgen-ng/src/space_http_signature.rs.
  const RUST_PRESENTATION = {
    source: 'stratos-feedgen-ng/src/space_http_signature.rs',
    signingKeyFill: 1,
    headers: {
      authorization: 'Atproto-Space-Credential misato-credential',
      'atproto-space-audience': 'did:plc:tokyo3',
      'signature-input':
        'sig=("authorization" "atproto-space-audience");tag="atproto-space-credential"',
      signature:
        'sig=:a3jD9GLACE/7cxT/Ui44YkimF1tcWhWb9AgeYzQafP6oE97sVb38WYR4Eqy2rh4x2fWZrebVAliLPkE88woMGw==:',
    },
  }
  // Copied from the Rust test `a_delegation_for_fixed_inputs_is_byte_for_byte_stable`
  // in stratos-feedgen-ng/src/service_auth.rs; it signs at clock second 1000.
  const RUST_DELEGATION = {
    source: 'stratos-feedgen-ng/src/service_auth.rs',
    signingKeyHex:
      '2fe8e925727a16e4970a5b0a556d9f8263b7c6b894885ca2857c8878938aa97b',
    authority: 'did:web:localhost%3A3100',
    spaceUri: 'at:space/did:web:localhost%3A3100/zone.stratos.space.feed/nerv',
    token:
      'eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJhdHByb3RvLXNwYWNlLWRlbGVnYXRpb24rand0Iiwia2lkIjoiI2F0cHJvdG8ifQ.eyJpc3MiOiJkaWQ6d2ViOmZlZWRnZW4uZXhhbXBsZS50ZXN0Iiwic3ViIjoiYXQ6c3BhY2UvZGlkOndlYjpsb2NhbGhvc3QlM0EzMTAwL3pvbmUuc3RyYXRvcy5zcGFjZS5mZWVkL25lcnYiLCJhdWQiOiJkaWQ6d2ViOmxvY2FsaG9zdCUzQTMxMDAjYXRwcm90b19wZHMiLCJpYXQiOjEwMDAsImV4cCI6MTA2MCwianRpIjoibm9uY2UifQ.dBaNYuvHe_V--AayTy6vQusFWf4r00gbbEvpJ4AeWRMdbpTrWDB-rdlEsvpczXAEmkcGkHlsAqhu67xtN11EJA',
    frozenClockSeconds: 1000,
  }
  // Copied from stratos-service/tests/space-credential-fixed-mint.test.ts.
  const SERVICE_CREDENTIAL = {
    source: 'stratos-service/tests/space-credential-fixed-mint.test.ts',
    authority: 'did:web:bebop.example',
    spaceUri: 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew',
    authoritySigningKeyHex: 'bb'.repeat(32),
    holderKeyHex: '55'.repeat(32),
    credentialId: 'spike-spiegel-credential',
    frozenClockSeconds: 1_000_000_000,
    token:
      'eyJ0eXAiOiJhdHByb3RvLXNwYWNlLWNyZWRlbnRpYWwrand0IiwiYWxnIjoiRVMyNTZLIiwia2lkIjoiI2F0cHJvdG8ifQ.eyJpc3MiOiJkaWQ6d2ViOmJlYm9wLmV4YW1wbGUiLCJzdWIiOiJhdDpzcGFjZS9kaWQ6d2ViOmJlYm9wLmV4YW1wbGUvem9uZS5zdHJhdG9zLnNwYWNlLmZlZWQvY3JldyIsImlhdCI6MTAwMDAwMDAwMCwiZXhwIjoxMDAwMDAwNjAwLCJqdGkiOiJzcGlrZS1zcGllZ2VsLWNyZWRlbnRpYWwiLCJjbmYiOnsia2lkIjoiZGlkOmtleTp6RG5hZVdNOHptQml3emY4bjQydk1DUGRYQVdQdnQ4VDEzWFFNQlhabVpvTEIzZkNGIn0sInN0cmF0b3NCb3VuZGFyeVJldmlzaW9uIjoxfQ.LPYdky2qhc7JLfDnxcEJH9NdXh-kcpvEk-4mk_WC1rp8P1oexCV-rW3iqDhugUXP1tFLJnnNQDA_bfVaZKl2xQ',
  }

  // Copied from the Rust tests in the `oracle_cross_check` module of
  // stratos-feedgen-ng/src/space_mac.rs: what the Rust code makes for the fixed
  // ephemeral key of hpke-export-oracle.json.
  const RUST_MAC_REQUEST = {
    source: 'stratos-feedgen-ng/src/space_mac.rs',
    acceptSignature:
      'mac=("atproto-space-commit";sf);keyid="did:key:zDnaeoA2SUkGYYDAVZBKgd4xWMGadgX2U29YPw8iEvCuELmfi";tag="atproto-space-commit"',
    sharedSecretBase64: '2XYP6iF5whnXMOd8HStZcRr/FOrpIZNfLnyoleNwbw4=',
  }
  const rustSecret = Uint8Array.from(
    Buffer.from(RUST_MAC_REQUEST.sharedSecretBase64, 'base64'),
  )
  const crossCheckCommit = {
    ver: 1,
    repo: REPO,
    space: 'at:space/did:web:nerv.example/zone.stratos.space.feed/tokyo3',
    rev: REVISIONS[3],
    data: new Uint8Array(
      createHash('sha256').update('rei-ayanami-tokyo3').digest(),
    ),
  }
  const crossCheckRequest = space.parseMacRequest(
    RUST_MAC_REQUEST.acceptSignature,
    space.COMMIT_MAC_PROFILE,
  )
  const oracleSecret =
    crossCheckRequest &&
    space.decapsulate(authorKem, crossCheckRequest.keyShare)
  const secretsAgree =
    oracleSecret !== undefined &&
    Buffer.from(oracleSecret).equals(Buffer.from(rustSecret))
  const { headers: crossCheckHeaders } =
    crossCheckRequest && secretsAgree
      ? space.createCommitMacHeaders(crossCheckCommit, {
          ...crossCheckRequest,
          sharedSecret: rustSecret,
        })
      : { headers: undefined }

  const presentationKey = await P256Keypair.import(
    new Uint8Array(32).fill(RUST_PRESENTATION.signingKeyFill),
  )
  const delegationKey = await Secp256k1Keypair.import(
    fromHex(RUST_DELEGATION.signingKeyHex),
  )
  const authorityKey = await Secp256k1Keypair.import(
    fromHex(SERVICE_CREDENTIAL.authoritySigningKeyHex),
  )

  writeFixture(
    'stratos-produced.json',
    {
      classification: 'upstream-signed-target-uri',
      oracle,
      generator,
      upstreamVerified: true,
      reproducible: true,
    },
    {
      note: 'Values Stratos produced, judged by the oracle. upstreamVerified is the oracle verdict. spaceUri is a hand-written at:space/ uri held as an opaque claim.',
      rustPresentation: {
        source: RUST_PRESENTATION.source,
        signingKeyFill: RUST_PRESENTATION.signingKeyFill,
        keyId: presentationKey.did(),
        headers: RUST_PRESENTATION.headers,
        verdict: await verdictCode(() =>
          space.verifyCredentialSig(
            RUST_PRESENTATION.headers,
            presentationKey.did(),
          ),
        ),
      },
      rustDelegation: {
        source: RUST_DELEGATION.source,
        signingKeyHex: RUST_DELEGATION.signingKeyHex,
        authority: RUST_DELEGATION.authority,
        spaceUri: RUST_DELEGATION.spaceUri,
        token: RUST_DELEGATION.token,
        frozenClockSeconds: RUST_DELEGATION.frozenClockSeconds,
        verdicts: await judgeToken(
          'delegation',
          RUST_DELEGATION.token,
          RUST_DELEGATION.frozenClockSeconds,
          delegationKey.did(),
          {
            aud: space.spaceHostAud(RUST_DELEGATION.authority),
            sub: RUST_DELEGATION.spaceUri,
          },
        ),
      },
      rustMacRequest: {
        source: RUST_MAC_REQUEST.source,
        acceptSignature: RUST_MAC_REQUEST.acceptSignature,
        sharedSecret: bytesField(rustSecret),
        commit: {
          ver: crossCheckCommit.ver,
          repo: crossCheckCommit.repo,
          space: crossCheckCommit.space,
          rev: crossCheckCommit.rev,
          data: bytesField(crossCheckCommit.data),
        },
        oracle: {
          parseRequest: crossCheckRequest ? 'accepted' : 'refused',
          keyShare: crossCheckRequest?.keyShare ?? null,
          decapsulate: secretsAgree ? 'same-secret' : 'different-secret',
          createCommitMacHeaders: crossCheckHeaders ? 'made' : 'not-made',
        },
        responseHeaders: crossCheckHeaders ?? null,
      },
      serviceCredential: {
        source: SERVICE_CREDENTIAL.source,
        authority: SERVICE_CREDENTIAL.authority,
        spaceUri: SERVICE_CREDENTIAL.spaceUri,
        authoritySigningKeyHex: SERVICE_CREDENTIAL.authoritySigningKeyHex,
        holderKeyHex: SERVICE_CREDENTIAL.holderKeyHex,
        credentialId: SERVICE_CREDENTIAL.credentialId,
        token: SERVICE_CREDENTIAL.token,
        frozenClockSeconds: SERVICE_CREDENTIAL.frozenClockSeconds,
        verdicts: await judgeToken(
          'credential',
          SERVICE_CREDENTIAL.token,
          SERVICE_CREDENTIAL.frozenClockSeconds,
          authorityKey.did(),
          { sub: SERVICE_CREDENTIAL.spaceUri },
        ),
      },
    },
  )
}

if (writeCommitMac) {
  const { hmacSha256 } = await importFrom('@atproto/crypto')
  const { ByteSequence, serializeDictionary } =
    await importFrom('structured-headers')

  const MAC_SPACE =
    'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
  const COVERED = 'atproto-space-commit'
  const INPUT = 'signature-input'
  const SIGNATURE = 'signature'
  const REQUEST = 'acceptSignature'
  const TAG = `tag="${COVERED}"`
  const dataOf = (seed) =>
    new Uint8Array(createHash('sha256').update(seed).digest())
  const macCommit = {
    ver: 1,
    repo: REPO,
    space: MAC_SPACE,
    rev: REVISIONS[3],
    data: dataOf('faye-valentine-bebop'),
  }
  const FIELD_ORDER = ['ver', 'repo', 'space', 'rev', 'data']
  const members = (commit, order = FIELD_ORDER) =>
    new Map(
      order.map((name) => [
        name,
        [
          name === 'data'
            ? new ByteSequence(Buffer.from(commit.data).toString('base64'))
            : commit[name],
          new Map(),
        ],
      ]),
    )
  const memberText = (commit, name) =>
    serializeDictionary(members(commit, [name]))
  const base64Of = (bytes) => Buffer.from(bytes).toString('base64')
  const macField = (mac) => `mac=:${base64Of(mac)}:`
  const macOver = (header, signatureParams) =>
    hmacSha256(
      sharedSecret,
      new TextEncoder().encode(
        `"${COVERED}";sf: ${header}\n"@signature-params": ${signatureParams}`,
      ),
    )

  const { headers: accepted } = space.createCommitMacHeaders(macCommit, {
    ...macRequest,
    sharedSecret,
  })
  const params = macRequest.signatureParams
  if (accepted[INPUT] !== `mac=${params}`)
    throw new Error('signature-input is not the requested parameters')
  const acceptedMac = macOver(accepted[COVERED], params)
  if (accepted[SIGNATURE] !== macField(acceptedMac))
    throw new Error('the signature base is not the one the oracle MACs')

  const CHANGED = {
    ver: 2,
    repo: 'did:plc:jetblack',
    space: 'at:space/did:web:bebop.example/zone.stratos.space.feed/ein',
    rev: REVISIONS[2],
    data: dataOf('ein-the-data-dog'),
  }
  const bodyJson = (change) =>
    Object.fromEntries(
      Object.entries(change).map(([name, value]) => [
        name,
        value instanceof Uint8Array ? bytesField(value) : value,
      ]),
    )
  const swap = (text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`no ${from} in ${text}`)
    return text.replace(from, to)
  }

  const applyCase = (entry) => {
    const headers = { ...accepted }
    for (const [name, pair] of Object.entries(entry.edit ?? {}))
      if (name !== REQUEST) headers[name] = swap(headers[name], pair)
    Object.assign(headers, entry.set)
    for (const name of entry.remove ?? []) delete headers[name]
    return headers
  }
  const judgeCase = async (entry) => {
    const headers = applyCase(entry)
    const commit = { ...macCommit, ...entry.bodyChange }
    const {
      accepted: isAccepted,
      error,
      message,
    } = await verdictOf(() =>
      space.verifyCommitMac(commit, {
        keyShare,
        sharedSecret,
        headers: new Headers(headers),
      }),
    )
    if (error !== undefined && error !== 'SpaceMacError')
      throw new Error(`unexpected ${error}`)
    return isAccepted ? 'accepted' : `refused: ${message}`
  }
  const caseJson = ({ name, edit, set, remove, bodyChange }) => ({
    name,
    ...(edit && { edit: inlineIfShort(edit) }),
    ...(set && { set: inlineIfShort(set) }),
    ...(remove && { remove }),
    ...(bodyChange && { bodyChange: inlineIfShort(bodyJson(bodyChange)) }),
  })

  // An edited covered header with a MAC the oracle's own HMAC makes over it,
  // for the cases where the header changes and the MAC has to follow.
  const remade = (edit) => ({
    edit: { [COVERED]: edit },
    set: {
      [SIGNATURE]: macField(macOver(swap(accepted[COVERED], edit), params)),
    },
  })
  const TAG_AT = ';tag='
  const algEdit = [TAG_AT, ';alg="hmac-sha256";tag=']
  const algRequest = space.parseMacRequest(
    swap(macRequestHeader, algEdit),
    COVERED,
  )
  const { headers: algHeaders } = space.createCommitMacHeaders(macCommit, {
    ...algRequest,
    sharedSecret,
  })
  const reorder = [`ver=1, repo="${REPO}"`, `repo="${REPO}", ver=1`]
  const field = (name) => [
    memberText(macCommit, name),
    memberText({ ...macCommit, [name]: CHANGED[name] }, name),
  ]
  const INPUT_EDITS = {
    'no tagged member': [TAG_AT, ';tug='],
    'tag atproto-space-repo': [
      `${TAG_AT}"${COVERED}`,
      `${TAG_AT}"atproto-space-repo`,
    ],
    'covered component without sf': ['";sf)', '")'],
    'an extra covered component': ['";sf)', '";sf "content-type")'],
    'keyid of another key share': [keyShare, otherSigner.did()],
    'another alg': [TAG_AT, ';alg="ed25519";tag='],
  }

  const caseInputs = [
    { name: 'accepted as made' },
    {
      name: 'under another label',
      edit: { [INPUT]: ['mac=', 'faye='], [SIGNATURE]: ['mac=', 'faye='] },
    },
    {
      name: 'a second signature of another tag',
      edit: {
        [INPUT]: [
          'mac=',
          `other=("${COVERED}";sf);tag="faye-valentine-test", mac=`,
        ],
        [SIGNATURE]: ['mac=', 'other=:Zm9v:, mac='],
      },
    },
    {
      name: 'alg hmac-sha256 in the request',
      edit: { [REQUEST]: algEdit, [INPUT]: algEdit },
      set: { [SIGNATURE]: algHeaders[SIGNATURE] },
    },
    {
      name: 'extra spaces between members',
      edit: { [COVERED]: [', ', ',   '] },
    },
    {
      name: 'members re-ordered with the old mac',
      edit: { [COVERED]: reorder },
    },
    {
      name: 'members re-ordered, mac over that order',
      ...remade(reorder),
    },
    {
      name: 'an extra member, mac over it',
      ...remade(['ver=1,', 'ver=1, note="swordfish",']),
    },
    {
      name: 'a member parameter, mac over it',
      ...remade(['ver=1', 'ver=1;note="spike"']),
    },
    ...FIELD_ORDER.map((name) => ({
      name: `${name} changed in the header only`,
      edit: { [COVERED]: field(name) },
    })),
    ...FIELD_ORDER.map((name) => ({
      name: `${name} changed in the body only`,
      bodyChange: { [name]: CHANGED[name] },
    })),
    {
      name: 'two tagged members',
      edit: { [INPUT]: ['mac=', `faye=();${TAG}, mac=`] },
    },
    ...Object.entries(INPUT_EDITS).map(([name, pair]) => ({
      name,
      edit: { [INPUT]: pair },
    })),
    {
      name: 'signature of 31 bytes',
      set: { [SIGNATURE]: macField(acceptedMac.slice(0, 31)) },
    },
    { name: 'covered header missing', remove: [COVERED] },
    {
      name: 'only an Atproto-Space-Mac header',
      set: { 'atproto-space-mac': base64Of(acceptedMac) },
      remove: [COVERED, INPUT, SIGNATURE],
    },
  ]
  const cases = []
  for (const entry of caseInputs)
    cases.push({ ...caseJson(entry), verdict: await judgeCase(entry) })

  // The oracle accepts these with a MAC made over them; Stratos refuses each,
  // so the expected verdict is written by hand and the oracle's is recorded.
  const strictCommit = async (name, change, reason) => {
    const commit = { ...macCommit, ...change }
    const { headers } = space.createCommitMacHeaders(commit, {
      ...macRequest,
      sharedSecret,
    })
    const [changed] = Object.keys(change)
    const entry = {
      name,
      edit: {
        [COVERED]: [
          memberText(macCommit, changed),
          memberText(commit, changed),
        ],
      },
      set: { [SIGNATURE]: headers[SIGNATURE] },
      bodyChange: change,
    }
    return {
      ...caseJson(entry),
      oracleVerdict: await judgeCase(entry),
      expectedStratos: 'refused',
      reason,
    }
  }
  const stricter = [
    await strictCommit(
      'ver 2 in header and body',
      { ver: 2 },
      'ver must be the integer 1',
    ),
    await strictCommit(
      'rev that is not a TID',
      { rev: 'not-a-tid' },
      'rev must be a TID',
    ),
    await strictCommit(
      'data of 31 bytes',
      { data: macCommit.data.slice(0, 31) },
      'data must be exactly 32 bytes',
    ),
    await strictCommit(
      'ver as the string "1"',
      { ver: '1' },
      'the body commit must have exactly typed fields',
    ),
  ]

  writeFixture(
    'commit-mac.json',
    {
      classification: 'upstream-signed-target-uri',
      oracle,
      generator,
      upstreamVerified: true,
      reproducible: true,
    },
    {
      note: 'edit replaces the first text with the second in an accepted header; set overwrites; remove drops; bodyChange alters the commit compared. verdict is the oracle verifyCommitMac verdict. space is an opaque at:space/ claim. stricter: the oracle accepts, Stratos refuses (hand label).',
      acceptSignature: macRequestHeader,
      sharedSecret: bytesField(sharedSecret),
      commit: bodyJson(macCommit),
      headers: accepted,
      cases,
      stricter,
    },
  )
}

if (writeKemKeys) {
  const { Secp256k1Keypair, formatDidVerificationMethod, bytesToMultibase } =
    await importFrom('@atproto/crypto')

  const DOCUMENT_DID = 'did:plc:spike'
  const OTHER_DID = 'did:plc:vicioussyndicate'
  const secp256k1Key = await Secp256k1Keypair.import(fromHex('66'.repeat(32)))
  const multikeyOf = (keypair) => keypair.did().slice('did:key:'.length)
  const method = (id, type, publicKeyMultibase) => ({
    id,
    type,
    publicKeyMultibase,
  })
  const kemMultikey = (id) => method(id, 'Multikey', multikeyOf(authorKem))
  const signingMethod = method('#atproto', 'Multikey', multikeyOf(signer))
  const document = (verificationMethod, id = DOCUMENT_DID) => ({
    id,
    verificationMethod,
  })
  const KEM_ID = '#atproto_kem'

  // The key judgement is the oracle's: its crypto package decodes the method and
  // its encapsulate refuses anything that is not a P-256 did:key. Which method a
  // document selects is written by hand from the rules in did/src/atproto.ts.
  const judgeKey = async (candidate) => {
    const { accepted, message } = await verdictOf(() =>
      space.encapsulate(formatDidVerificationMethod(candidate)),
    )
    return accepted ? 'accepted' : `refused: ${message}`
  }

  const found = (name, doc, selected) => ({
    name,
    doc,
    selected,
    outcome: { kemKey: formatDidVerificationMethod(selected) },
  })
  const refused = (name, doc, reason, selected) => ({
    name,
    doc,
    selected,
    outcome: { refused: reason },
  })
  const malformed = method(KEM_ID, 'Multikey', 'zNot0AValidBase58Key')
  const secp256k1Method = method(KEM_ID, 'Multikey', multikeyOf(secp256k1Key))
  const relative = kemMultikey(KEM_ID)
  const absolute = kemMultikey(`${DOCUMENT_DID}${KEM_ID}`)
  const legacy = method(
    KEM_ID,
    'EcdsaSecp256r1VerificationKey2019',
    bytesToMultibase(authorKem.publicKeyBytes(), 'base58btc'),
  )
  const rivalKem = method(
    `${DOCUMENT_DID}${KEM_ID}`,
    'Multikey',
    multikeyOf(signer),
  )
  const otherDidMethod = kemMultikey(`${OTHER_DID}${KEM_ID}`)

  const entries = [
    found(
      'a Multikey method with a relative id',
      document([relative]),
      relative,
    ),
    found('the same with an absolute id', document([absolute]), absolute),
    found('the legacy type with bare key bytes', document([legacy]), legacy),
    found(
      'a KEM key different from the signing key',
      document([signingMethod, relative]),
      relative,
    ),
    refused('no KEM method', document([signingMethod]), 'no-kem-method'),
    refused(
      'a KEM method holding a secp256k1 key',
      document([secp256k1Method]),
      'wrong-curve',
      secp256k1Method,
    ),
    refused(
      'a Multikey with a malformed multibase string',
      document([malformed]),
      'malformed-key',
      malformed,
    ),
    refused(
      'a document whose id is another DID',
      document([otherDidMethod], OTHER_DID),
      'document-id-mismatch',
    ),
    refused(
      'two methods with the KEM id',
      document([relative, rivalKem]),
      'ambiguous-kem-method',
    ),
  ]
  const cases = []
  for (const { name, doc, selected, outcome } of entries) {
    cases.push({
      name,
      document: doc,
      expected: outcome,
      ...(selected && { oracleKeyVerdict: await judgeKey(selected) }),
    })
  }

  writeFixture(
    'kem-keys.json',
    {
      classification: 'upstream-uri-free',
      oracle,
      generator,
      upstreamVerified: true,
      reproducible: true,
    },
    {
      note: 'Hand-written documents for a synthetic DID; controller is not read, so it is left out. Keys are encoded by the oracle crypto package; oracleKeyVerdict is its encapsulate verdict on the selected method. The selected method and each refused reason are hand labels.',
      did: DOCUMENT_DID,
      cases,
    },
  )
}

// Writes the fixtures next to this file from the published upstream packages.
//
// usage: node generate-oracle-vectors.mjs <oracle-directory> [--tokens]
//                                          [--stratos-produced]
//                                          [--commit-mac] [--kem-keys]
//                                          [--record-cid] [--op-pages]
//                                          [--repo-archive]
//
// Without a flag every file but token-audiences.json, stratos-produced.json,
// commit-mac.json, kem-keys.json, record-cid.json, op-pages.json and
// repo-archive.json is written, and the output is the same on every run.
// token-audiences.json holds tokens the oracle stamps with the clock and a
// random jti, so it is written only with --tokens and then kept.
// stratos-produced.json takes its inputs from constants copied out of Stratos
// tests (named beside each one) and is written only with --stratos-produced.
// commit-mac.json, kem-keys.json, record-cid.json, op-pages.json and
// repo-archive.json are reproducible and each has its own flag. The last three
// also need @atproto/lex-json at the oracle version, installed beside
// @atproto/space in the oracle directory: the JSON-to-data-model step is that package's.
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
const writeRecordCid = flags.includes('--record-cid')
const writeOpPages = flags.includes('--op-pages')
const writeRepoArchive = flags.includes('--repo-archive')
const KNOWN_FLAGS = [
  '--tokens',
  '--stratos-produced',
  '--commit-mac',
  '--kem-keys',
  '--record-cid',
  '--op-pages',
  '--repo-archive',
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

const LEX_JSON_PACKAGE = '@atproto/lex-json'
const LEX_JSON_INTEGRITY =
  'sha512-rF7Ogq8ZSLjmO82l9ZMjlO7zcKTm/079pQPTdMx92bIdRuWRk3TT3bF+iNkkwE1KNfKpKGACGxpvTXosb4ircg=='
const withLexJson = (oracleHeader) => ({
  ...oracleHeader,
  additionalPackages: [
    {
      package: LEX_JSON_PACKAGE,
      version: ORACLE_VERSION,
      integrity: LEX_JSON_INTEGRITY,
    },
  ],
})
const loadLexJson = async (neededBy) => {
  const lexJsonEntry = resolve(
    oracleDirectory,
    'node_modules/@atproto/lex-json/dist/index.js',
  )
  try {
    const lexJsonVersion = JSON.parse(
      readFileSync(resolve(dirname(dirname(lexJsonEntry)), 'package.json')),
    ).version
    if (lexJsonVersion !== ORACLE_VERSION)
      throw new Error(`it is ${lexJsonVersion}, expected ${ORACLE_VERSION}`)
    return await import(pathToFileURL(realpathSync(lexJsonEntry)).href)
  } catch (error) {
    console.error(
      `${neededBy} need ${LEX_JSON_PACKAGE}@${ORACLE_VERSION} installed beside @atproto/space in ${oracleDirectory}: ${error.message}`,
    )
    process.exit(1)
  }
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
        'sig=:a3jD9GLACE/7cxT/Ui44YkimF1tcWhWb9AgeYzQafP5X7CESqkIDp3uH7VNJUeHN4vFg/8BCnCxoe4mGCVkZNg==:',
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

  // Copied from the Rust tests `the_cids_of_three_fixed_records_are_the_pinned_constants`
  // (space_record.rs, module cross_check_inputs) and
  // `the_state_and_digest_after_the_fixed_operations_are_the_pinned_constants`
  // (space_ops.rs).
  const RUST_RECORD_CIDS = {
    source: 'stratos-feedgen-ng/src/space_record.rs',
    records: [
      {
        name: 'a post',
        constant: 'POST',
        json: '{"$type":"zone.stratos.feed.post","text":"Whatever happens, happens"}',
        rustCid: 'bafyreicy76sh4fkqtlr7dmtiakbzpfqhvcsx36lf26eifaplxgl5abq2fq',
      },
      {
        name: 'a follow',
        constant: 'FOLLOW',
        json: '{"$type":"app.bsky.graph.follow","subject":"did:plc:spikespiegel","createdAt":"2026-09-22T00:00:00.000Z"}',
        rustCid: 'bafyreigoyb4wgujzkp5jj6l4fiduaefr5hkjfcjwc7tgwbrrfkol4ur22m',
      },
      {
        name: 'a post with a link and bytes',
        constant: 'LINKED',
        json: '{"$type":"zone.stratos.feed.post","text":"Ein","embed":{"image":{"$type":"blob","ref":{"$link":"bafkreicmhqydaeykjinrosvewdw2dkzg6gwayo4i3d5tbyav4mls6nlica"},"mimeType":"image/png","size":3},"thumb":{"$bytes":"AQID"}}}',
        rustCid: 'bafyreiamr44qnmy5gt77wtssi7svuhexyfxffcqhn2mgzrfdqb7fi4lrgi',
      },
    ],
  }
  const RUST_SET_HASH = {
    source: 'stratos-feedgen-ng/src/space_ops.rs',
    // [revision index, collection, rkey, record constant written, constant it replaced]
    steps: [
      [0, POST, 'swordfish', 'POST', null],
      [0, 'app.bsky.graph.follow', 'spike', 'FOLLOW', null],
      [1, POST, 'ein', 'LINKED', null],
      [2, POST, 'swordfish', 'LINKED', 'POST'],
      [2, 'app.bsky.graph.follow', 'spike', null, 'FOLLOW'],
    ],
    rustStateBase64:
      '2XO4rvh6d7V4ZV4CtsHfVcg6/kIzVMnH7bhxDYhWIMcRTGeXScVudsEkxLtUQklzOMC/w4AVKuQBCsKicSg4ENJB77oFrCJUadTybOxPqz4hOADcwq0tcAF7VY16DjnEfHJEUiPZJT6H5EMJYkXZhuDzHN9+BNC9luedqdIBFgaquXTxWHBj/9i+VFx0rOevL0+YXvqux8jrQ+asE2fFJdwLeJtiO9b9bLFQyz3iXuyB++pgQ6mAO3rAV4T7pP5vf8SMslDDTRkevenEcIQtTBOSGvJ6bWY9aQfQlX+fsYz8PXuQUcaJxkqhFdpLe5q5zOBh8DJSGELZLZzw7DQUqf4XFicp8vLbwDp6StsD0dycWa6bN1yCFQrA52D+8PK3zvhvn2aHxWUSSQi9taHkXpp2cQqhhQMrWA4651gz+eIdHM5koI1YY6aYiVQl6ry6tsJSLKy/0xhqdiwFdPnAOFPHX0cdXxoPIfjrrgvcclJzrbRL0pgq9U5MyrsrcjleTu7vkI/gtiXeysw0ghqhW8hCNnK7poSSMUpZCcN9nQmTt3PTNJ2597LhqINNVbH6s6hJR5b9YQ/1ciT92eI6FSaXetlBicYVS84qxCE/DJqEwgYtPM641j3WuwzgwHUwR3RDzCTW8X+kR2dLXtHnhUc9SIjJEiSv1sEy17CIMefsaIbjoArtyTelbl6mG1swj5tjpeREY/+uGvxFnwRBn8WyHOaXRyzfh6fgQKg9WCfWAmcWEqFv+QecDClJ3YrSDl6UxGZA3uawVYhKUieLOhzkGeDjySOn8fV44lyRjRHUtoVf46wqWZEgEZdWsPJ2AUBtSS41D3YP+tjyZ7dbDzlUHUrU8J6yiRh42jzHKnJOeW7VJEloIos58egU7YQYBesUdIX+Thax6S512kQ0OKBy7oUUCi27aUbkZg+HDRcMmM5Hgaf+1xHddk+EBn4AgPFt2Y2A3W2RG4mwmVvT3+RtE2rozbdLhEsfm2vMo6Gv9XwIQoc7PGAeQyTNn1lO+ZpnoIzNUcrWbwd4K0FgDlf2w+5wt3mlZ3Nvw5uqP+jJzcB35/xS26XK372ZrphS5FUYCNR0Tzd8efXRzx404RV7VItr02KOkWqZE4YtDXiX1arTHOcJREtsinV+UCAZzEstlva9ILSM1jP5wCZAKWWM1G9bQwDc+7j0boPmO65R8iaWmVPADE3DVh3ctn7XDTJGqNLbs5sn6ZWGPeXpOFBDHNuLSz307HlfyjRAqjHjLUtIucIl2w59JDCpPvID+7MhKl2fSR6AVJnrzk702yBgHKy51kVLf3e87Qs2dBDFvxAEAC9vGKc87mYdS8vF0Pnt7MWe93XX/8g/p/X/BiZhqmgX4L99OdD1+HNo+n5h+3JkamMYcxBpU4BmSRMCErhtzGishm2Jox5bPuAD84eZHi49y2H+y9lCRwdVXuYKLsuVvqDTz74gCSZP/9bndEaIo4p/gu3C0zLL1lvDA523J1YabiGtuiPjZJvlCC6VoEHk0n21yutSIpsUPnYWiE81Zd/BvVGDjeeefvMJmp26iz7IYADXbFzrW707wsYNfYbizedwAVQWktpNODHJyZX9u+4dM7kHJ0OgO/7etZ+IAAogpz3Q5IVZjCJf+4ckXhn9drofWBmN4sEoPwSIUbP5Qb8ABLaBSB+hVUVWuK+J2Iv0UsYVmO2CNsb/rDWydmcfI9VtVC70s3E5DtgqP/NqjwnhkNSd9/Xt3wpv9L24q32sCU1NllMDTT7hkwWqLvBjNeH9r08qe15IcCI6LmcuvOKVputLEaqcC8qOX+skmktVOKCqFV1vx7IT4aBLlczY/uFSPh25mkoRnyEs1TqpAcKxeQvPxdRRNY0KSfHOt/0+vkfit7Ggt2AVdeDqf1o3kT60B5ulndVybsszo4dM7Deg0W/udOeMJsYRfzHAFMLzUqA4EGHXnTb8cXVDphNNvcPsiqRIQ9nUBD1uwOdFrci+3MiFU/DLaCv6CKN+NuWTiMYE2o3CBHdBDH+yDJSuthRhgaifk+dbBgrWfEcm214txiEj0mSgMI/PbMqKmMA1cgWvgO0EnjJAisGaxz6d1cvV7c/dwr45rLQBHUBJNXOx2FsCQ55OAQphICHU5Vp+/+I0/P4Ny3v828af2oenIHd/+X2YeUrt9Di4r3L/EX5CQFgj4c5hkwdFeDIiI+FnlLZ+mUGzkuuBedNNX4Go/GZJFWOBHgA1b1uvrtFuGPcKawADN68nDEDFupI//ez00UIRpeyHEVL7aPIp5HeG38KWHlWyakXA4IuF3wH4yodKBzDvXnm1sAu0JRQKm6xaeJnRrr0GhQC0anCej8k52DRBXSB383Vm2l6tobOfkNJDiWWms2JKv1WgtwJ5sw6hSYtineAoJs2tL+BIxpTHN64OOgTr4uuZ7rmsikkdyBoSwMuXRG+XmDAlrBJMnUyS+uGweEWctgWeQ1rccPXFlbHUGQ19B5xhXyJvoeT84TuBk4H8Yl/CLtfYKGni79yhmOo6eNyOTJIdlkZfiSVOcwvvaj8EyhZMUfLiCkOREzYfwEGWXOgU02vsla0sC3fIt8WMC8f3Hd3W7PYgaXHWMPBxMAhBqu2AieLk9WfTKl+FVrPvV5DMb72Mw6jlvTtZSL/mtY4OrT//Qj8D75buG0rogJFLT+lN4vmb+t5RkaOJbmpgXGgNLS8gp/B8Lybwh1uBkO1x1tolizY=',
    rustDigestHex:
      'd6104e12dc24c5dff84fdd4a7eee2f789b50a7b51820695ec7ed9c00147015fa',
  }
  const { lexParse: crossLexParse, lexToJson: crossLexToJson } =
    await loadLexJson('--stratos-produced')
  const crossRecords = {}
  for (const record of RUST_RECORD_CIDS.records)
    crossRecords[record.constant] = await space.serializeRecord(
      POST,
      'k',
      crossLexParse(record.json),
    )
  const crossJson = Object.fromEntries(
    RUST_RECORD_CIDS.records.map((record) => [
      record.constant,
      crossLexToJson(crossLexParse(record.json)),
    ]),
  )
  const crossRepo = new space.RepoCommit()
  crossRepo.applyOps(
    RUST_SET_HASH.steps.map(
      ([revision, collection, rkey, written, replaced]) => ({
        rev: REVISIONS[revision],
        collection,
        rkey,
        cid: written === null ? null : crossRecords[written].cid,
        prev: replaced === null ? null : crossRecords[replaced].cid,
        ...(written === null ? {} : { value: crossJson[written] }),
      }),
    ),
  )
  const crossCommit = crossRepo.toCommit({
    space: 'at:space/did:web:nerv.example/zone.stratos.space.feed/tokyo3',
    repo: REPO,
    rev: REVISIONS[2],
  })

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
      oracle: withLexJson(oracle),
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
      rustRecordCids: {
        source: RUST_RECORD_CIDS.source,
        records: RUST_RECORD_CIDS.records.map((record) => ({
          name: record.name,
          constant: record.constant,
          json: record.json,
          rustCid: record.rustCid,
          oracleCid: crossRecords[record.constant].cid.toString(),
        })),
      },
      rustSetHash: {
        source: RUST_SET_HASH.source,
        steps: RUST_SET_HASH.steps,
        rustStateBase64: RUST_SET_HASH.rustStateBase64,
        rustDigestHex: RUST_SET_HASH.rustDigestHex,
        oracleStateBase64: Buffer.from(crossRepo.setHash.state()).toString(
          'base64',
        ),
        oracleDigestHex: Buffer.from(crossCommit.data).toString('hex'),
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

if (writeRecordCid || writeOpPages || writeRepoArchive) {
  const lexJson = await loadLexJson(
    '--record-cid, --op-pages and --repo-archive',
  )
  const { lexParse, lexToJson } = lexJson
  const { cidForRawBytes, parseCidSafe } = await importFrom('@atproto/lex-data')
  // multiformats is a dependency of lex-data only and exports no base58 entry
  // for require, so the file is imported by path.
  const { base58btc } = await import(
    pathToFileURL(
      resolve(
        dirname(realpathSync(spaceRequire.resolve('@atproto/lex-data'))),
        '../../../multiformats/dist/src/bases/base58.js',
      ),
    ).href
  )
  const recordOracle = withLexJson(oracle)

  const hex = (bytes) => Buffer.from(bytes).toString('hex')
  const FEED_POST = 'zone.stratos.feed.post'
  const POST_CUSTODY_URI = `at://${REPO}/${FEED_POST}/swordfish`
  const SUBJECT_CID =
    'bafyreihypg3uvx3sc754r22emkw6ujpiqjozie6puum4ie4egt2jqxz6wa'
  const BLOB_CID = (
    await cidForRawBytes(new TextEncoder().encode('ein'))
  ).toString()
  const postJson = (text) => JSON.stringify({ $type: FEED_POST, text })
  const strongRefJson = (type) =>
    JSON.stringify({
      $type: type,
      subject: { uri: POST_CUSTODY_URI, cid: SUBJECT_CID },
    })

  const RECORD_TEXTS = [
    ['a post', postJson('See you space cowboy')],
    ['a post, edited', postJson('See you space cowboy, edited')],
    ['a post, edited again', postJson('See you space cowboy, again')],
    ['a post by Ein', postJson('Bark')],
    ['a like with a strong reference', strongRefJson(LIKE)],
    ['a repost', strongRefJson(REPOST)],
    [
      'a follow',
      JSON.stringify({
        $type: 'app.bsky.graph.follow',
        subject: 'did:plc:jetblack',
      }),
    ],
    [
      'a post with a blob reference',
      JSON.stringify({
        $type: FEED_POST,
        text: 'Ein',
        embed: {
          $type: 'app.bsky.embed.images',
          images: [
            {
              alt: 'a corgi',
              image: {
                $type: 'blob',
                ref: { $link: BLOB_CID },
                mimeType: 'image/png',
                size: 3,
              },
            },
          ],
        },
      }),
    ],
    [
      'a record with bytes',
      JSON.stringify({
        $type: FEED_POST,
        text: 'bytes',
        raw: { $bytes: 'AQID' },
      }),
    ],
    [
      'nested maps and arrays',
      JSON.stringify({
        a: { b: { c: [1, [2, [3, {}]], { d: [] }] } },
        list: [{ x: 1 }, { y: [true, null] }],
      }),
    ],
    [
      'keys that sort by length then bytes',
      JSON.stringify({ b: 1, aa: 2, a: 3, B: 4, ab: 5, 10: 6, 9: 7, '': 8 }),
    ],
    [
      'non-ASCII keys and values',
      JSON.stringify({
        é: 'café',
        日本: '東京',
        z: 'Tokyo-3',
        ab: 'ünïcode',
        long: 'a'.repeat(24),
        '🛸': 'Bebop',
      }),
    ],
    [
      'integers across every width',
      JSON.stringify({
        n: [
          0, -1, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296,
          9007199254740991, -9007199254740991, -24, -25, -256, -257,
        ],
      }),
    ],
    [
      'empty containers, null and booleans',
      '{"empty":{},"list":[],"nothing":null,"yes":true,"no":false}',
    ],
  ]

  // One line per outcome keeps the file small: `accepted <bytes hex> <cid>`, or
  // `refused: <error name>: <message>`.
  const outcomeOf = async (text, strict) => {
    try {
      const encoded = await space.serializeRecord(
        FEED_POST,
        'k',
        lexParse(text, { strict }),
      )
      return `accepted ${hex(encoded.bytes)} ${encoded.cid.toString()}`
    } catch (error) {
      return `refused: ${error.name}: ${error.message}`
    }
  }
  const withStrict = async (text) => {
    const loose = await outcomeOf(text, false)
    const strict = await outcomeOf(text, true)
    return loose === strict
      ? { oracle: loose }
      : { oracle: loose, oracleStrict: strict }
  }
  const nested = (levels) => `${'['.repeat(levels)}${']'.repeat(levels)}`
  // The record map is the first container, so `depth` containers deep is the
  // map holding depth - 1 arrays inside one another.
  const deep = (depth) => `{"a":${nested(depth - 1)}}`

  const edgeInputs = [
    ['a number with a fraction', '{"a":1.5}'],
    ['the integer 2^53', '{"a":9007199254740992}'],
    ['an exponent beyond the double range', '{"a":1e400}'],
    ['a $link beside another key', `{"$link":"${SUBJECT_CID}","x":1}`],
    ['a $link holding a number', '{"$link":5}'],
    [
      'a $link in base58 version 0',
      '{"$link":"QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"}',
    ],
    ['a $bytes unpadded', '{"$bytes":"AQ"}'],
    ['a $bytes padded', '{"$bytes":"AQ=="}'],
    ['a $bytes beside another key', '{"$bytes":"AQ","x":1}'],
    ['a key written twice', '{"a":1,"a":2}'],
    ['a string of 256 bytes', JSON.stringify({ s: 'a'.repeat(256) })],
    [
      'a combining character beside its precomposed form',
      JSON.stringify({ s: ['é', 'é'] }),
    ],
    ['a top level array', '[1,"a",null]'],
    ['nesting 32 deep', deep(32)],
  ]
  const STRICTER_REASONS = {
    number: 'Stratos refuses any number written with a fraction or exponent.',
    depth: 'Stratos refuses nesting deeper than 32; the oracle has no limit.',
    link: 'Stratos refuses a $link whose text is not a canonical CID; the oracle reads a plain map or the CID.',
    bytes:
      'Stratos refuses a $bytes that is not standard base64 without trailing bits; the oracle is lenient.',
    text: 'The Rust JSON reader refuses a lone surrogate escape; the oracle writes U+FFFD.',
  }
  const stricterInputs = [
    ['the number 1.0', '{"a":1.0}', 'number'],
    ['the number 1e2', '{"a":1e2}', 'number'],
    ['the number -0', '{"a":-0}', 'number'],
    ['nesting 33 deep', deep(33), 'depth'],
    ['a $link that is not a CID', '{"$link":"not a cid"}', 'link'],
    [
      'a $link in uppercase',
      `{"$link":"${SUBJECT_CID.toUpperCase()}"}`,
      'link',
    ],
    [
      'a $link in base58 version 1',
      '{"$link":"zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7"}',
      'link',
    ],
    ['a $bytes that is not base64', '{"$bytes":"!"}', 'bytes'],
    ['a $bytes in the URL-safe alphabet', '{"$bytes":"-_8"}', 'bytes'],
    ['a $bytes with trailing bits', '{"$bytes":"AR"}', 'bytes'],
    ['a lone surrogate escape', '{"a":"\\ud800"}', 'text'],
  ]

  const records = []
  for (const [name, json] of RECORD_TEXTS) {
    const encoded = await space.serializeRecord(FEED_POST, 'k', lexParse(json))
    records.push({
      name,
      json,
      oracle: await outcomeOf(json, false),
      parsed: encoded,
    })
  }

  if (writeRecordCid) {
    const edge = []
    for (const [name, json] of edgeInputs)
      edge.push({
        name,
        json: inlineIfShort(json),
        ...(await withStrict(json)),
      })
    const stricter = []
    for (const [name, json, reason] of stricterInputs) {
      const verdict = await withStrict(json)
      if (!verdict.oracle.startsWith('accepted'))
        throw new Error(`${name}: the oracle refuses it, so it is not stricter`)
      stricter.push({
        name,
        json,
        ...verdict,
        expectedStratos: 'refused',
        reason,
      })
    }

    const canonical = records[0].parsed.cid.toString()
    const cidStrings = []
    const cidText = (name, text) => {
      const parsed = parseCidSafe(text, { flavor: 'cbor' })
      cidStrings.push({
        name,
        text,
        parsesAsCborCid: parsed !== null,
        canonicalText: parseCidSafe(text)?.toString() === text,
      })
    }
    cidText('the canonical text', canonical)
    cidText(
      'the same cid in base58 version 1',
      parseCidSafe(canonical).toString(base58btc),
    )
    cidText('the same cid in uppercase', canonical.toUpperCase())
    cidText('a version 0 cid', 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
    cidText('a raw-codec cid', BLOB_CID)

    writeFixture(
      'record-cid.json',
      {
        classification: 'upstream-uri-free',
        oracle: recordOracle,
        generator,
        upstreamVerified: true,
        reproducible: true,
      },
      {
        note: 'json is the text a host sends. An oracle outcome is `accepted <bytes hex> <cid>` or `refused: <error>: <message>`: lexParse (strict false), then the lex-cbor encoder serializeRecord uses, then the CID. oracleStrict appears only where lexParse with strict true differs. A stricter row is one the oracle accepts and Stratos refuses; its reason is named in reasons. cidStrings holds the oracle CBOR-flavour parse and whether the text is the canonical text of the CID it parses to.',
        records: records.map(({ name, json, oracle }) => ({
          name,
          json: inlineIfShort(json),
          oracle,
        })),
        edge,
        reasons: STRICTER_REASONS,
        stricter,
        cidStrings,
      },
    )
  }

  if (writeOpPages) {
    const OP_SPACE =
      'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
    const FOLLOW = 'app.bsky.graph.follow'
    const record = (name) => {
      const found = records.find((entry) => entry.name === name)
      if (!found) throw new Error(`no record named ${name}`)
      return found
    }
    const write = (rev, collection, rkey, name, previous = null) => {
      const current = record(name)
      return {
        rev,
        collection,
        rkey,
        cid: current.parsed.cid,
        prev: previous === null ? null : record(previous).parsed.cid,
        value: lexToJson(lexParse(current.json)),
      }
    }
    const remove = (rev, collection, rkey, previous) => ({
      rev,
      collection,
      rkey,
      cid: null,
      prev: record(previous).parsed.cid,
    })
    const [revA, revB, revC, revD] = REVISIONS
    const pagesOfOps = [
      [
        write(revA, FEED_POST, 'swordfish', 'a post'),
        write(revB, FEED_POST, 'swordfish', 'a post, edited', 'a post'),
        write(revB, LIKE, 'ed', 'a like with a strong reference'),
        write(revB, REPOST, 'jet', 'a repost'),
        write(revB, FOLLOW, 'faye', 'a follow'),
      ],
      [
        write(revC, FEED_POST, 'ein', 'a post by Ein'),
        remove(revD, LIKE, 'ed', 'a like with a strong reference'),
        write(
          revD,
          FEED_POST,
          'swordfish',
          'a post, edited again',
          'a post, edited',
        ),
      ],
      [],
    ]

    const repoState = new space.RepoCommit()
    const wireOp = (op) => ({
      ...op,
      cid: op.cid === null ? null : op.cid.toString(),
      prev: op.prev === null ? null : op.prev.toString(),
    })
    const pages = []
    let rev = revA
    for (const pageOps of pagesOfOps) {
      repoState.applyOps(pageOps)
      if (pageOps.length > 0) rev = pageOps.at(-1).rev
      const commit = repoState.toCommit({ space: OP_SPACE, repo: REPO, rev })
      pages.push({
        ops: pageOps.map(wireOp),
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
      })
    }

    writeFixture(
      'op-pages.json',
      {
        classification: 'upstream-signed-target-uri',
        oracle: recordOracle,
        generator,
        upstreamVerified: true,
        reproducible: true,
      },
      {
        note: 'Three pages in the wire shape of listRepoOps over a hand-written new-form space string. Each commit is made by the oracle RepoCommit after that page, so its data is the set hash digest of the repo then. Values and cids are those of record-cid.json.',
        pages,
        stateAfterLastPage: bytesField(repoState.setHash.state()),
      },
    )
  }

  if (writeRepoArchive) {
    const ARCHIVE_SPACE =
      'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
    const FOLLOW = 'app.bsky.graph.follow'
    // Strict byte order of the paths, as the archive requires.
    const archiveRecords = [
      [LIKE, 'ed', 'a like with a strong reference'],
      [REPOST, 'jet', 'a repost'],
      [FOLLOW, 'faye', 'a follow'],
      [FEED_POST, 'swordfish', 'a post'],
    ].map(([collection, rkey, name]) => {
      const found = records.find((entry) => entry.name === name)
      if (!found) throw new Error(`no record named ${name}`)
      return {
        collection,
        rkey,
        name,
        bytes: found.parsed.bytes,
        cid: found.parsed.cid,
      }
    })

    const judge = (bytes, commit, headers) =>
      verdictOf(() =>
        space.verifyRepoStarFull([bytes], {
          space: commit.space,
          repo: commit.repo,
          keyShare,
          sharedSecret,
          headers: new Headers(headers),
        }),
      )
    const archiveOf = async (commit, list) => {
      const chunks = []
      for await (const chunk of space.writeRepoStar(commit, list))
        chunks.push(chunk)
      const { headers } = space.createCommitMacHeaders(commit, {
        ...macRequest,
        sharedSecret,
      })
      return { chunks, bytes: Buffer.concat(chunks), headers, commit }
    }
    const varint = (value) => {
      const out = []
      let rest = value
      while (rest >= 0x80) {
        out.push((rest % 0x80) | 0x80)
        rest = Math.floor(rest / 0x80)
      }
      out.push(rest)
      return Buffer.from(out)
    }
    const hexOf = (bytes) => Buffer.from(bytes).toString('hex')

    // The archives and the edits that make the refused variants, for one
    // spelling of the space. Offsets come from the writer's own chunks: magic,
    // meta length, meta, then five chunks for each pair (control, key length,
    // key, value length, value).
    const familyFor = async (spaceString) => {
      const commitFor = (rev, list) =>
        new space.RepoCommit()
          .applyOps(
            list.map(({ collection, rkey, cid }) => ({
              collection,
              rkey,
              cid,
              prev: null,
            })),
          )
          .toCommit({ space: spaceString, repo: REPO, rev })
      const full = await archiveOf(
        commitFor(REVISIONS[3], archiveRecords),
        archiveRecords,
      )
      const empty = await archiveOf(commitFor(REVISIONS[0], []), [])

      let at = 0
      const next = (chunk) => {
        const start = at
        at += chunk.length
        return start
      }
      const [magic, metaLength, meta, ...rest] = full.chunks
      next(magic)
      next(metaLength)
      const metaAt = next(meta)
      const pairs = []
      for (let i = 0; i + 5 < rest.length; i += 5) {
        const start = next(rest[i])
        next(rest[i + 1])
        const keyAt = next(rest[i + 2])
        const valueLengthAt = next(rest[i + 3])
        const valueAt = next(rest[i + 4])
        pairs.push({
          start,
          keyAt,
          valueLengthAt,
          valueAt,
          end: at,
          key: Buffer.from(rest[i + 2]),
          value: Buffer.from(rest[i + 4]),
        })
      }
      if (pairs.length !== archiveRecords.length)
        throw new Error('the writer did not give one pair per record')
      if (metaAt !== 4 + metaLength.length || pairs[0].key.length >= 0x80)
        throw new Error('the archive is not laid out as the edits assume')

      const whole = full.bytes
      const find = (text, within = whole) => {
        const found = within.indexOf(Buffer.from(text))
        if (found < 0) throw new Error(`no ${text} in the archive`)
        return found
      }
      const post = pairs[3]
      const textMember = post.value.subarray(1, 1 + 1 + 4 + 1 + 20)
      if (textMember.subarray(0, 5).toString('hex') !== '6474657874')
        throw new Error('the post is not laid out as expected')
      const typeFirst = Buffer.concat([
        post.value.subarray(0, 1),
        post.value.subarray(1 + textMember.length),
        textMember,
      ])
      const revAt = find(
        full.commit.rev,
        whole.subarray(0, metaAt + meta.length),
      )
      const typeText = 'atproto-space-repo'
      const slashAt = pairs[0].keyAt + pairs[0].key.indexOf('/')
      const textAt = post.valueAt + find('See you', post.value)
      const wholePair = (pair) => hexOf(whole.subarray(pair.start, pair.end))

      const edits = [
        ['cut before the end marker', whole.length - 1, 1, ''],
        ['cut inside a value', whole.length - 5, 5, ''],
        ['an unknown control byte', pairs[0].start, 1, '02'],
        ['one byte after the end', whole.length, 0, '00'],
        [
          'two records swapped',
          pairs[2].start,
          pairs[3].end - pairs[2].start,
          wholePair(pairs[3]) + wholePair(pairs[2]),
        ],
        ['a record repeated', pairs[2].end, 0, wholePair(pairs[2])],
        ['a path that is not collection/rkey', slashAt, 1, hexOf('.')],
        ['one value byte changed', textAt, 1, hexOf('T')],
        [
          'a non-canonical encoding of the record',
          post.valueAt,
          post.value.length,
          hexOf(typeFirst),
        ],
        [
          'metadata type changed',
          find(typeText) + typeText.length - 2,
          1,
          hexOf('x'),
        ],
        [
          'metadata revision changed',
          revAt + full.commit.rev.length - 1,
          1,
          hexOf('e'),
        ],
        [
          'a metadata length above the limit',
          4,
          metaAt - 4,
          hexOf(varint(64 * 1024 + 1)),
        ],
        [
          'a key length above the limit',
          pairs[0].start + 1,
          pairs[0].keyAt - pairs[0].start - 1,
          hexOf(varint(4 * 1024 + 1)),
        ],
        [
          'a value length above the limit, no bytes',
          pairs[0].valueLengthAt,
          whole.length - pairs[0].valueLengthAt,
          hexOf(varint(1024 * 1024 + 1)),
        ],
      ].map(([name, from, remove, insert]) => ({
        name,
        at: from,
        remove,
        insert,
      }))
      const edited = ({ at: from, remove, insert }) =>
        Buffer.concat([
          whole.subarray(0, from),
          Buffer.from(insert, 'hex'),
          whole.subarray(from + remove),
        ])
      return { full, empty, edits, edited }
    }

    // The pinned reader checks the metadata's space against the earlier
    // spelling of a space reference only, so it refuses the new spelling before
    // it reads a record. Its verdicts are therefore taken on a twin of each
    // archive that differs in the spelling of the space and in the MAC headers
    // that cover it, and nowhere else.
    const family = await familyFor(ARCHIVE_SPACE)
    const twin = await familyFor(LEGACY_SPACE)
    const outcome = (verdict) =>
      verdict.accepted ? 'accepted' : `refused: ${verdict.error}`
    const readerOnNewSpelling = outcome(
      await judge(family.full.bytes, family.full.commit, family.full.headers),
    )
    if (readerOnNewSpelling === 'accepted')
      throw new Error(
        'the oracle reader reads the new spelling; no twin needed',
      )
    const twinOutcome = async (bytes, commit, headers) => {
      const verdict = await judge(bytes, commit, headers)
      const message = verdict.message ?? ''
      if (message.includes(ARCHIVE_SPACE) || message.includes(LEGACY_SPACE))
        throw new Error('a verdict names the space, so the twin would show')
      return outcome(verdict)
    }
    const outcomeOfFull = await twinOutcome(
      twin.full.bytes,
      twin.full.commit,
      twin.full.headers,
    )
    const outcomeOfEmpty = await twinOutcome(
      twin.empty.bytes,
      twin.empty.commit,
      twin.empty.headers,
    )
    if (outcomeOfFull !== 'accepted' || outcomeOfEmpty !== 'accepted')
      throw new Error('the oracle refuses an archive it wrote')
    const refused = []
    for (const [index, edit] of family.edits.entries()) {
      const twinEdit = twin.edits[index]
      if (twinEdit.name !== edit.name || twinEdit.insert !== edit.insert)
        throw new Error(`${edit.name}: the twin edit differs`)
      const verdict = await twinOutcome(
        twin.edited(twinEdit),
        twin.full.commit,
        twin.full.headers,
      )
      if (verdict === 'accepted')
        throw new Error(`the oracle accepts ${edit.name}`)
      refused.push({ ...edit, insert: inlineIfShort(edit.insert), verdict })
    }

    const base64Of = (bytes) => Buffer.from(bytes).toString('base64')
    writeFixture(
      'repo-archive.json',
      {
        classification: 'upstream-signed-target-uri',
        oracle: recordOracle,
        generator,
        upstreamVerified: true,
        reproducible: true,
      },
      {
        note: 'Oracle archives over a new-form space, in base64. macHeaders answer the request of commit-mac.json (the response signature-input is that request). A verdict is `accepted` or `refused: <error name>` from verifyRepoStarFull, taken on a twin archive in the earlier space spelling, which the pinned reader insists on (readerOnNewSpelling). An edit replaces remove bytes at offset at by insert (hex).',
        archive: {
          bytes: base64Of(family.full.bytes),
          macHeaders: {
            'atproto-space-commit': family.full.headers['atproto-space-commit'],
            signature: family.full.headers.signature,
          },
          verdict: outcomeOfFull,
          readerOnNewSpelling,
        },
        empty: {
          bytes: base64Of(family.empty.bytes),
          verdict: outcomeOfEmpty,
        },
        refused,
      },
    )
  }
}

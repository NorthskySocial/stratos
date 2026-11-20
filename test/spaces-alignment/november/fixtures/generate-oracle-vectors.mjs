// Writes the fixtures next to this file from the published upstream packages.
//
// usage: node generate-oracle-vectors.mjs <oracle-directory>
//
// The oracle directory is a standalone install of the exact package named
// below, outside this repository, and also holds the RFC vector file as
// hpke-test-vectors.json (pinned by hash below). Expected bytes come from that
// package or from the RFC entry, never from Stratos code. No network, clock or
// randomness: every key and input is fixed here.
import { createHash } from 'node:crypto'
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
const AUTHORIZATION = 'Atproto-Space spike-spiegel-test-credential'
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
if (!oracleDirectory) {
  console.error('usage: node generate-oracle-vectors.mjs <oracle-directory>')
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
// committed bytes are exactly what this generator writes.
const PRINT_WIDTH = 80
const layout = (value, indent, prefixWidth) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const pad = ' '.repeat(indent + 2)
  const close = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const primitive = value.every(
      (item) => item === null || typeof item !== 'object',
    )
    if (primitive) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
      if (indent + prefixWidth + inline.length + 1 <= PRINT_WIDTH) return inline
    }
    const items = value.map((item) => `${pad}${layout(item, indent + 2, 0)}`)
    return `[\n${items.join(',\n')}\n${close}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const lines = entries.map(([key, child]) => {
    const head = `${JSON.stringify(key)}: `
    return `${pad}${head}${layout(child, indent + 2, head.length)}`
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
    withHeaders({ authorization: 'Atproto-Space jet-black-test-credential' }),
    signer.did(),
  ],
]

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

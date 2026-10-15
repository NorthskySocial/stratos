import { P256PrivateKey } from '@atcute/crypto'

export const vectorKey = await P256PrivateKey.importRaw(
  Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)),
)
export const vectorContext = {
  credential: 'ZXZh.bmVydg.c2hpbmpp',
  credentialKey: await vectorKey.exportPublicKey('did'),
  authority: 'did:web:nerv.tokyo.jp',
  method: 'GET',
  target: '/xrpc/zone.stratos.space.getRecord?a=%2F&a=rei?',
  body: new Uint8Array(),
  now: 1000,
}
export const vectorProof =
  'eyJ0eXAiOiJzdHJhdG9zLXJlcXVlc3QtcHJvb2YtdjErand0IiwiYWxnIjoiRVMyNTYiLCJraWQiOiJkaWQ6a2V5OnpEbmFlcHNMN0FYZW5Ka1ZZZGtoNUt1S3NTVTdZa2g3a3lYYUxMVTdhdU45RldTaVoifQ.eyJhdWQiOiJkaWQ6d2ViOm5lcnYudG9reW8uanAiLCJodG0iOiJHRVQiLCJ0YXJnZXQiOiIveHJwYy96b25lLnN0cmF0b3Muc3BhY2UuZ2V0UmVjb3JkP2E9JTJGJmE9cmVpPyIsImF0aCI6Im9RWW0wRXUtd1UyX0F5U0NNb0VNbFNaTjl1YzBNYUdyV01BdHZXcXlhbVEiLCJib2R5X2hhc2giOiI0N0RFUXBqOEhCU2EtX1RJbVctNUpDZXVRZVJrbTVOTXBKV1pHM2hTdUZVIiwiaWF0IjoxMDAwLCJleHAiOjEwNjAsImp0aSI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHcifQ.SWvlvgSIICg-cYFJ3MQL9Bn-pcqT0c0h1YVtJTlPEWtB8dYNl2Dy2-0hqzQAkyK-dZEcFq0Wl0FsdnDs6SJrNQ'

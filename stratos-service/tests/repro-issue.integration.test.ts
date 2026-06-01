import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestServer } from './helpers/test-server.js'

describe('Reproduction: listRecords 500 and createRecord 400', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await TestServer.create()
    await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  it('com.atproto.repo.listRecords should not return 500 when cursor is provided', async () => {
    // We just want to check that it doesn't 500
    // Using a simple rkey as a cursor (which previously caused 500)
    const response = await fetch(
      `${server.url}/xrpc/com.atproto.repo.listRecords?repo=did:plc:user1&collection=app.bsky.feed.post&cursor=some-rkey`,
    )

    // Even if it returns 400 because of invalid repo/collection, it should NOT be 500
    // In our test server, since the repo doesn't exist, it might return 400 or empty 200 depending on implementation
    // But the fix was for a 500 error during cursor parsing.
    expect(response.status).not.toBe(500)

    // If it's a valid query but empty repo, it's usually 200 or 400
    const body = await response.json()
    if (response.status === 500) {
      console.error('listRecords failed with 500:', body)
    }
  })

  it('com.atproto.repo.createRecord should be a POST and accept a body (no 400)', async () => {
    const response = await fetch(
      `${server.url}/xrpc/com.atproto.repo.createRecord`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repo: 'did:plc:user1',
          collection: 'app.bsky.feed.post',
          record: {
            text: 'Hello Stratos!',
            createdAt: new Date().toISOString(),
          },
        }),
      },
    )

    // If it was still a query (GET) internally, it would return 400 "A request body was provided when none was expected"
    // If it's correctly a procedure (POST), it should proceed to auth check and return 401 (Unauthorized)
    // since we didn't provide any auth headers.
    expect(response.status).toBe(401)

    const body = await response.json()
    if (response.status === 400) {
      expect(body.message).not.toBe(
        'A request body was provided when none was expected',
      )
    }
  })

  it('com.atproto.repo.uploadBlob should be a POST and accept a binary body (no 400)', async () => {
    // We send a tiny fake image or random bytes
    const bodyData = Buffer.from('fake-image-data')
    const response = await fetch(
      `${server.url}/xrpc/com.atproto.repo.uploadBlob`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
        },
        body: bodyData,
      },
    )

    // If it was still a query (GET) internally OR if no input schema was defined,
    // it would return 400 "A request body was provided when none was expected"
    // If it's correctly a procedure (POST) with an input schema, it should proceed to auth check
    // and return 401 (Unauthorized) since we didn't provide any auth headers.
    expect(response.status).toBe(401)

    const body = await response.json()
    if (response.status === 400) {
      expect(body.message).not.toBe(
        'A request body was provided when none was expected',
      )
    }
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import axios from 'axios'
import { TestServer } from './helpers/test-server.js'

describe('createRecord POST integration', () => {
  let testServer: TestServer

  beforeEach(async () => {
    testServer = await TestServer.create()
    await testServer.start()
  })

  afterEach(async () => {
    await testServer.stop()
  })

  it('should accept POST request for com.atproto.repo.createRecord', async () => {
    const url = `${testServer.url}/xrpc/com.atproto.repo.createRecord`

    // We expect a 401 AuthRequired because we aren't providing a valid token,
    // but the point is that it should NOT be a 400 InvalidRequest
    // "A request body was provided when none was expected"
    try {
      await axios.post(
        url,
        {
          repo: 'did:plc:user',
          collection: 'app.bsky.feed.post',
          record: {
            text: 'test post',
            createdAt: new Date().toISOString(),
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    } catch (error: any) {
      // If it was still a GET, it would fail with 400 before even checking auth
      // because xrpc-server would reject the body.
      expect(error.response.status).toBe(401)
      expect(error.response.data.error).toBe('AuthenticationRequired')
    }
  })

  it('should accept POST request for zone.stratos.repo.hydrateRecords', async () => {
    const url = `${testServer.url}/xrpc/zone.stratos.repo.hydrateRecords`

    // This is a procedure that does not require auth (requireAuth: false in handler)
    const res = await axios.post(
      url,
      {
        uris: [],
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )

    expect(res.status).toBe(200)
    expect(res.data.records).toEqual([])
  })
})

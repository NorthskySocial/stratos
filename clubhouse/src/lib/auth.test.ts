import { describe, expect, it } from 'vitest'
import {
  buildSpaceWriteScope,
  CLUBHOUSE_POST_SCOPE,
  CLUBHOUSE_SPACE_ACTIONS,
  createClubhouseAuth,
} from './auth'

describe('Clubhouse OAuth post permissions', () => {
  it('requests full repository access to the room post collection', () => {
    expect(CLUBHOUSE_POST_SCOPE).toBe('repo:zone.stratos.feed.post')
  })

  it('requests every supported space record action in canonical order', () => {
    expect(
      buildSpaceWriteScope({
        serviceDid: 'did:web:nerv.example',
        actions: CLUBHOUSE_SPACE_ACTIONS,
      }),
    ).toBe(
      'space:zone.stratos.space.feed?authority=did%3Aweb%3Anerv.example&collection=zone.stratos.feed.post&action=read&action=create&action=update&action=delete',
    )
  })
})

describe('Clubhouse requested OAuth scope', () => {
  const SPACE_SCOPE =
    'space:zone.stratos.space.feed?authority=did%3Aweb%3Anerv.example&collection=zone.stratos.feed.post&action=read&action=create&action=update&action=delete'
  const FEED_SCOPE = 'rpc:zone.stratos.feedgen.getFeed?aud=*'
  const BASE_SCOPE =
    'atproto repo:zone.stratos.actor.enrollment repo:zone.stratos.feed.post'

  it('requests the feed generator call and the space scope when both are configured', () => {
    expect(
      createClubhouseAuth({
        serviceDid: 'did:web:nerv.example',
        feedgenDid: 'did:web:magi.example',
        pdsSpaceUriByRoom: {},
      }).scope,
    ).toBe(`${BASE_SCOPE} ${FEED_SCOPE} ${SPACE_SCOPE}`)
  })

  it('omits the feed generator call without a feed generator DID', () => {
    expect(
      createClubhouseAuth({
        serviceDid: 'did:web:nerv.example',
        pdsSpaceUriByRoom: {},
      }).scope,
    ).toBe(`${BASE_SCOPE} ${SPACE_SCOPE}`)
  })

  it('omits the space scope without a service DID', () => {
    expect(
      createClubhouseAuth({
        feedgenDid: 'did:web:magi.example',
        pdsSpaceUriByRoom: {},
      }).scope,
    ).toBe(`${BASE_SCOPE} ${FEED_SCOPE}`)
  })

  it('requests only the base scope with neither DID', () => {
    expect(createClubhouseAuth({ pdsSpaceUriByRoom: {} }).scope).toBe(
      BASE_SCOPE,
    )
  })

  it('names no wildcard and no management action', () => {
    const { scope } = createClubhouseAuth({
      serviceDid: 'did:web:nerv.example',
      feedgenDid: 'did:web:magi.example',
      pdsSpaceUriByRoom: {},
    })
    expect(scope).not.toMatch(/collection=\*|manage/)
    expect(scope.split(' ').filter((entry) => entry.includes('*'))).toEqual([
      FEED_SCOPE,
    ])
  })
})

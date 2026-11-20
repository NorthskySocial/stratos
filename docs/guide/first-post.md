---
audience: App developers
type: Tutorial
prerequisites: An enrolled account, the Stratos service DID and URL, and an OAuth session
status: current
---

# Tutorial: Your First Private Post

In this tutorial you write one private post. You will find a user's
enrollment, work out where their private posts are kept, and write a post
that only members of one boundary can read.

It takes four steps: look up the enrollment, choose the repository host,
write the post, and read it back.

## Prerequisites

- An AT Protocol account that is enrolled with a Stratos service. If it is
  not enrolled yet, see [User Enrollment](/client/enrollment), or sign in
  once with the [demo webapp](/guide/webapp).
- The DID and URL of that Stratos service. This tutorial uses
  `did:web:stratos.example.com` and `https://stratos.example.com`.
- An OAuth session for the user, from `@atproto/oauth-client-browser` or
  `@atproto/oauth-client-node`. Stratos accepts DPoP-bound OAuth sessions
  only; an app password does not work.
- Basic TypeScript.

## 1. Install the client

```bash
pnpm add @northskysocial/stratos-client @atproto/api
```

## 2. Look up the enrollment

Every enrolled user has a public `zone.stratos.actor.enrollment` record on
their PDS. It says which Stratos service they joined, which boundaries they
hold, and who keeps their private posts.

```typescript
import { getEnrollmentByServiceDid } from '@northskysocial/stratos-client'

const STRATOS_DID = 'did:web:stratos.example.com'
const STRATOS_URL = 'https://stratos.example.com'

const userDid = session.sub // the signed-in user's DID
const pdsUrl = 'https://pds.example.com' // the user's PDS

const enrollment = await getEnrollmentByServiceDid(userDid, pdsUrl, STRATOS_DID)

if (!enrollment) {
  throw new Error('This user is not enrolled with this Stratos service.')
}

console.log(enrollment.custody) // 'stratos' or 'pds'
console.log(enrollment.boundaries) // the boundaries the user holds
```

## 3. Choose the repository host

The post goes to one of two places, depending on **custody**:

- `stratos` custody: the Stratos service keeps the user's posts.
- `pds` custody: the user's own PDS keeps them, in a protected space.

`resolveRepositoryTarget` makes the choice. You give it the hosts you
already trust: the Stratos URL from your app's configuration, and the PDS
your session is bound to. It does not follow URLs published in the
enrollment record, because anyone can write those.

```typescript
import { resolveRepositoryTarget } from '@northskysocial/stratos-client'

const target = resolveRepositoryTarget(enrollment, {
  authorityServiceUrl: STRATOS_URL,
  sessionPdsUrl: pdsUrl,
})

if (target.kind === 'unresolved') {
  throw new Error(`Cannot route this user: ${target.reason}`)
}
```

`target.kind` is now `'stratos'` or `'pds'`, and `target.url` is where the
post goes.

## 4. Write the post

Pick one boundary the user holds. A post belongs to exactly one.

```typescript
const boundary = `${STRATOS_DID}/engineering`
const text = 'Hello from the engineering boundary!'
const createdAt = new Date().toISOString()
```

Choose the tab for the user's custody. The two tabs are the two branches
of one function.

::: code-group

```typescript [Stratos custody]
import { Agent } from '@atproto/api'

if (target.kind === 'stratos') {
  // Wrap the session's fetchHandler so the request goes to target.url and
  // still carries the session's DPoP proof.
  const stratos = new Agent((url, init) =>
    session.fetchHandler(new URL(url, target.url).href, init),
  )

  const res = await stratos.com.atproto.repo.createRecord({
    repo: userDid,
    collection: 'zone.stratos.feed.post',
    record: {
      $type: 'zone.stratos.feed.post',
      text,
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [
          { $type: 'zone.stratos.boundary.defs#Domain', value: boundary },
        ],
      },
      createdAt,
    },
  })

  console.log(res.data.uri)
  // at://did:plc:…/zone.stratos.feed.post/3k…
}
```

```typescript [PDS custody]
if (target.kind === 'pds') {
  // The space URI is the boundary, spelled the protocol's way.
  const space = `at://${STRATOS_DID}/space/zone.stratos.space.feed/engineering`

  const res = await session.fetchHandler(
    new URL('/xrpc/com.atproto.space.createRecord', target.url).href,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        space,
        repo: userDid,
        collection: 'zone.stratos.feed.post',
        validate: false,
        record: { $type: 'zone.stratos.feed.post', text, createdAt },
      }),
    },
  )

  if (!res.ok) throw new Error(`PDS write failed (${res.status})`)
}
```

:::

**Stratos custody.** Send a normal `createRecord` to the Stratos service. The
boundary must be the full identifier, it must belong to this Stratos
service, and the user must hold it. Otherwise Stratos rejects the write.

**PDS custody.** Write into the boundary's _space_ on the PDS. The record
carries no `boundary` field. The space it is written into is its boundary.
The address of the new record has seven segments and starts with the
Stratos DID, not the author:

```text
at://did:web:stratos.example.com/space/zone.stratos.space.feed/engineering/did:plc:…/zone.stratos.feed.post/3k…
```

Your OAuth session needs the space scope for this write. See
[User Enrollment](/client/enrollment) for the scopes to request.

## 5. Read it back

For a Stratos-kept post, read it from Stratos with the same agent. This
continues inside the `stratos` branch of step 4:

```typescript
const rkey = res.data.uri.split('/').pop()!

const { data } = await stratos.com.atproto.repo.getRecord({
  repo: userDid,
  collection: 'zone.stratos.feed.post',
  rkey,
})

console.log(data.value)
```

Try the same call from an account that does not hold the `engineering`
boundary. The answer is `RecordNotFound`. Stratos gives the same answer for
a post that does not exist, so nobody can probe for hidden posts.

Other members see the post in the boundary's feed, served by the
[feed generator](/architecture/feed-generator).

## What you did

1. Found a user's enrollment on their PDS.
2. Chose the repository host from custody, using only hosts you trust.
3. Wrote a post into exactly one boundary.
4. Saw that a non-member cannot tell the post exists.

## Next steps

- [Client Integration](/client/getting-started): the full client guide.
- [Boundaries](/client/boundaries): how boundaries restrict access.
- [Core Concepts](/guide/concepts): custody, spaces, and the trust model.

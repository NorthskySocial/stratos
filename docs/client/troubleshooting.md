---
audience: App developers
type: Troubleshooting
status: current
---

# Troubleshoot your app

Find the symptom, then follow the link for the detail. Every error name is
listed in [Error codes](/reference/errors).

| Symptom                                                                                 | Likely cause                                                   | Fix                                                                    |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Every request answers 401](#every-request-answers-401)                                 | The request sends `Authorization: Bearer`                      | Use the OAuth session's fetch handler with the absolute Stratos URL    |
| [`NotEnrolled` after OAuth](#notenrolled-after-completing-oauth)                        | The service uses an allowlist and the user is not on it        | Check `zone.stratos.enrollment.status`. The operator must grant access |
| [`PdsCustodyWriteForbidden`](#writes-fail-with-pdscustodywriteforbidden)                | The user has `pds` custody                                     | Write with `com.atproto.space.createRecord` on the user's PDS          |
| [A boundary error on write](#writes-fail-with-a-boundary-error)                         | The boundary is missing, foreign, or not held                  | Put one full boundary from the user's enrollment in `boundary.values`  |
| [A PDS-custody write fails](#a-pds-custody-write-fails)                                 | The session lacks the space scope                              | Ask the user to sign in again                                          |
| [Posts missing from the feed](#posts-not-appearing-in-the-feed)                         | The viewer lacks the boundary, or the author left              | Check the viewer's boundaries and the author's membership              |
| [Enrollment redirect fails](#enrollment-redirect-fails)                                 | No client metadata document proves the `redirect_uri`          | Publish client metadata and send `client_id`                           |
| [JSON error after enrollment](#the-browser-stops-on-a-json-error-after-enrollment)      | Stratos refused the enrollment                                 | Read the `error` in the JSON body                                      |
| [Requests reach the PDS](#requests-go-to-the-pds-instead-of-stratos)                    | `new Agent(session)` with a changed `serviceUrl`               | Wrap the session's fetch handler                                       |
| [429 errors](#rate-limiting-429-errors)                                                 | The DID passed the write rate limit                            | Retry with exponential backoff                                         |
| [DPoP nonce errors](#dpop-nonce-errors)                                                 | A proxy hides `DPoP-Nonce`                                     | Expose the header through CORS                                         |
| [`RecordNotFound` for a member](#a-record-reads-as-recordnotfound-for-an-enrolled-user) | The viewer lacks the boundary, or the author has `pds` custody | Check boundaries. Read PDS-hosted posts through the feed generator     |
| [`fetchAndVerifyRecord` fails](#fetchandverifyrecord-fails)                             | Stratos does not serve `com.atproto.sync.getRecord`            | Use `verifyRecordCid`                                                  |
| [`importRepo` fails](#importrepo-fails)                                                 | The service registers no handler for it                        | Use `com.atproto.repo.applyWrites`                                     |

## Every request answers 401

Stratos accepts a user's request only with DPoP. Send
`Authorization: DPoP <access_token>` and a `DPoP` proof header. A request with
`Authorization: Bearer <access_token>` answers `401 AuthenticationRequired`.

Use the fetch handler of your OAuth session and pass it the absolute Stratos
URL. See
[DPoP-aware transport](/client/getting-started#dpop-aware-transport).

## "NotEnrolled" after completing OAuth

The service may have an allowlist. Check the live status:

```bash
curl "https://stratos.example.com/xrpc/zone.stratos.enrollment.status?did=<your-did>"
```

`enrolled: false` with `eligible: false` means the operator must grant
access.

## Writes fail with PdsCustodyWriteForbidden

The user has `pds` custody. Their records live on their own PDS, and Stratos
refuses repo writes for them. Resolve the repository target and call
`com.atproto.space.createRecord` on the PDS. See
[Custody and Routing](/client/custody).

## Writes fail with a boundary error

See [Writing records](/reference/errors#writing-records) for every write
error.

| Error                | Fix                                                                  |
| -------------------- | -------------------------------------------------------------------- |
| `InvalidDomainCount` | Put exactly one entry in `boundary.values`.                          |
| `ServiceMismatch`    | Use a boundary of this Stratos service, with its service DID prefix. |
| `ForbiddenBoundary`  | Use a boundary from the user's enrollment.                           |
| `InvalidDomain`      | The boundary name is not a valid space key.                          |

## A PDS-custody write fails

1. Confirm the session holds the space scope. See
   [Space scope](/client/custody#space-scope).
2. If the scope is missing, ask the user to sign in again.
3. Confirm the `space` URI starts with the Stratos service DID and uses the
   type `zone.stratos.space.feed`.

## Posts not appearing in the feed

1. Check that the viewer holds the post's boundary.
2. Check the write response. A Stratos write returns the record URI.
3. Allow the feed generator a moment to collect the post.
4. For a PDS-hosted post, confirm the author is still a member. The feed
   generator reads only the repos of current members.

## Enrollment redirect fails

After enrollment, Stratos returns the browser to the `redirect_uri` you sent to
`/oauth/authorize`. You do not register that URL with the operator. You prove it is yours the same
way you prove an OAuth redirect: publish a client metadata document and name it with `client_id`.

If the response is `400 InvalidRequest` instead of a redirect:

1. Confirm you sent `client_id` with the authorize request.
2. Confirm the `client_id` URL uses `https`, includes a path, carries no fragment, and names a
   hostname rather than an IP address.
3. Fetch your `client_id` URL and confirm it returns JSON over HTTPS.
4. Confirm the document's own `client_id` field equals the URL it is served from.
5. Confirm `redirect_uris` declares a URL on the same origin as your `redirect_uri`.
6. Ensure the user's PDS supports ATprotocol OAuth.

Stratos reads the metadata document from its own server, not from the browser, so a CORS error in
the browser console is unrelated to this response. The response body gives one fixed message for
every read failure; the specific cause is in the service log.

If your app publishes no client metadata document, ask the operator to add your origin to
`STRATOS_ALLOWED_REDIRECT_ORIGINS`. Publishing the document is preferred, because it needs no
operator action.

## The browser stops on a JSON error after enrollment

Stratos does not redirect a failed enrollment back to your app. The browser
stays on the Stratos origin and shows a JSON body such as
`{ "error": "EnrollmentDenied" }`. Your app receives no `error` query
parameter. See [Handling the result](/client/enrollment#handling-the-result).

## Requests go to the PDS instead of Stratos

You are likely using `new Agent(session)` and then setting `serviceUrl`. Use
the fetch handler wrapper instead. See
[Write the post](/client/getting-started#_3-write-the-post).

## Rate limiting (429 errors)

Use exponential backoff. The default limit is 300 writes per 60-second window
per DID. An `applyWrites` call counts each write in the batch.

## DPoP nonce errors

On a `use_dpop_nonce` error, read the nonce from the `DPoP-Nonce` response
header and include it in the next proof. If a proxy sits in front of Stratos,
confirm it passes `DPoP-Nonce` through `Access-Control-Expose-Headers`.

## A record reads as RecordNotFound for an enrolled user

The viewer may not hold the record's boundary. Stratos answers HTTP 400 with
`error: "RecordNotFound"` for a missing record and for a denied one. The
status is not 404 and not 403.

Also check custody. Stratos read methods serve only Stratos-hosted records.
A `pds`-custody author's posts are on their PDS; read them through the feed
generator.

## fetchAndVerifyRecord fails

`fetchAndVerifyRecord` calls `com.atproto.sync.getRecord`, which the Stratos
service does not serve. Use `verifyRecordCid` on a `getRecord` response. See
[Verifying what you read](/client/reading-records#verifying-what-you-read).

## importRepo fails

The `zone.stratos.repo.importRepo` lexicon exists, but the service registers
no handler for it. Write records with `com.atproto.repo.applyWrites` instead.

## CORS and header requirements

A browser client calls Stratos across origins. The Stratos service sets these
headers itself. Check them when a proxy or gateway sits in front of it.

Stratos reflects the request origin in `Access-Control-Allow-Origin`.

**Allowed request headers** (`Access-Control-Allow-Headers`):

- `Authorization`: carries the DPoP-bound access token
- `DPoP`: carries the DPoP proof JWT
- `DPoP-Nonce`
- `Content-Type`
- `Signature`, `Signature-Input`, `Atproto-Space-Audience`: space credential
  requests
- `atproto-accept-labelers`, `atproto-proxy-type`
- `x-trace-id`

**Exposed response headers** (`Access-Control-Expose-Headers`):

- `DPoP-Nonce`: required for DPoP nonce rotation
- `WWW-Authenticate`: required for DPoP error recovery
- `x-trace-id`

### CORS flow

1. The browser sends a preflight `OPTIONS` request.
2. Stratos answers 204 and lists `Authorization` and `DPoP` as allowed
   headers.
3. On the real response, `DPoP-Nonce` is exposed, so the client can read the
   server's nonce.

### CORS failure symptoms

| Missing header                         | Symptom                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `DPoP` not in allowed headers          | Preflight fails. Every authenticated request shows a CORS error.            |
| `DPoP-Nonce` not exposed               | The client cannot read the nonce. Proofs use a stale nonce and loop on 401. |
| `WWW-Authenticate` not exposed         | The client cannot parse `use_dpop_nonce`.                                   |
| `Authorization` not in allowed headers | The access token is never sent. Every request answers 401.                  |

## Known pitfalls

### Async discovery race condition

If enrollment discovery is fire-and-forget, an account switch can leave stale
enrollment data:

```typescript
// Problem: if the user switches accounts before discovery completes,
// setEnrollment updates state for the wrong account.
getEnrollmentByServiceDid(did, pdsUrl, serviceDid)
  .then(setEnrollment)
  .catch(() => setEnrollment(null))
```

Key discovery to the active session and cancel on account change:

```typescript
// React pattern
useEffect(() => {
  let cancelled = false
  getEnrollmentByServiceDid(did, pdsUrl, serviceDid).then((enrollment) => {
    if (!cancelled) setEnrollment(enrollment)
  })
  return () => {
    cancelled = true
  }
}, [did, pdsUrl, serviceDid])
```

Both fragments assume `getEnrollmentByServiceDid` from
`@northskysocial/stratos-client`, React's `useEffect`, and a `setEnrollment`
state setter in your component.

### Reading the author from a space URI

A space record URI starts with the authority DID, not the author. The author
is the fifth segment. Code that splits a URI and takes the first part shows
the Stratos service as the author of every PDS-hosted post.

### Verification level ambiguity

A record read from Stratos can be checked for CID integrity only. That
confirms the content matches its CID. It does not confirm a signature. Do not
label it "verified" without a qualifier.

### Empty repo versus missing repo

For `stratos` custody, enrollment creates a repo with an empty signed commit.
An empty `collections` list from `describeRepo` is the normal state before the
first post.

`RepoNotFound` means Stratos hosts no repo for that DID. That is expected for
a `pds`-custody user. For a `stratos`-custody user it is an error. Check
custody before you decide.

### DPoP `htu` claim accuracy

The DPoP proof's `htu` claim must match the request URL. Pass the absolute
target URL to the session's fetch handler, not a relative path. A relative
path resolves against the session's PDS.

# Domain Boundaries

## Understanding Boundaries

Every Stratos record must include a `boundary` specifying which domains can access it. Boundary values are **service-qualified identifiers** in `{serviceDid}/{name}` format. The service DID is the `did:web` identity of the Stratos instance — retrieve it from the service's `/.well-known/did.json`.

```typescript
{
  boundary: {
    $type: 'zone.stratos.boundary.defs#Domains',
    values: [
      { $type: 'zone.stratos.boundary.defs#Domain', value: 'did:web:stratos.example.com/general' },
      { $type: 'zone.stratos.boundary.defs#Domain', value: 'did:web:stratos.example.com/writers' },
    ],
  },
}
```

## Visibility Rules

| Viewer | Can See Record? |
|--------|----------------|
| Record owner | ✅ Always |
| User with matching domain | ✅ Yes |
| User without matching domain | ❌ No |
| Unauthenticated | ❌ No |

## Multi-Domain Posts

Posts can be visible to multiple domains simultaneously:

```typescript
const crossDomainPost = {
  $type: 'zone.stratos.feed.post',
  text: 'Announcement for both groups',
  boundary: {
    $type: 'zone.stratos.boundary.defs#Domains',
    values: [
      { $type: 'zone.stratos.boundary.defs#Domain', value: 'did:web:stratos.example.com/fanart' },
      { $type: 'zone.stratos.boundary.defs#Domain', value: 'did:web:stratos.example.com/cosplay' },
    ],
  },
  createdAt: new Date().toISOString(),
}
```

A viewer with access to **either** `fanart` or `cosplay` will see this post.

## Getting User's Available Domains

```typescript
async function getUserDomains(agent: Agent): Promise<string[]> {
  const profile = await agent.getProfile({ actor: agent.session.did })
  return profile.data.associated?.stratosDomains ?? []
}
```

## Boundary Limits

| Field | Constraint |
|-------|-----------|
| `values` | Max 10 domains per record |
| `value` string | Max 253 characters |
| Domain names | Must be in the service's `STRATOS_ALLOWED_DOMAINS` list |

Records with boundaries outside the service's allowed list are rejected on write.

# Introduction

On AT Protocol, everything you post is public by design.

Some conversations need privacy. A writing group shares drafts. A community
plans an event. A team talks shop. Today those conversations leave the
network and move to a group chat somewhere else.

Stratos provides this privacy. A community runs a Stratos service, decides who is a
member, and its members share posts that only other members can read. Nobody
needs a new account. People keep their AT Protocol identity, handle,
and PDS.

If you want the idea without the vocabulary, read
[Shared Private Data, Explained Simply](/guide/what-is-stratos) first.

## How it works

Follow one post from the keyboard to a friend's screen.

1. **A user enrolls.** They sign in to a Stratos service with their existing
   account, through OAuth. Stratos records which _boundaries_ they belong to
   and writes one small public record, `zone.stratos.actor.enrollment`, to
   their PDS. That record tells apps where to look.
2. **The user writes a private post** for one boundary. Where the post is
   kept depends on the user's PDS. If the PDS supports permissioned spaces,
   the post stays there, in a protected space. If not, Stratos keeps it.
   Either way, Stratos decides who belongs.
3. **The feed generator collects posts.** It follows the members Stratos
   lists, and no one else. It verifies what it reads and keeps a bounded,
   encrypted copy.
4. **A viewer asks for a feed.** The request carries a signed token that
   says who is asking. The feed generator checks the viewer's current
   membership with Stratos and returns only posts they may read.

A private post never reaches the public firehose.

## Three words to know

| Word           | Meaning                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| **Boundary**   | A named group. A post belongs to exactly one boundary, and only members of it can read the post. |
| **Enrollment** | A user's membership of a Stratos service, and the list of boundaries they hold.                  |
| **Custody**    | Who keeps a user's private posts: Stratos, or the user's own PDS.                                |

[Core Concepts](/guide/concepts) explains each one. The
[Glossary](/guide/glossary) is the quick reference.

## What is in the repository

| Package              | Description                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `stratos-core`       | Domain logic, storage interfaces, schema, validation, MST commit builder |
| `stratos-service`    | The Stratos service: OAuth enrollment, record storage, credentials, sync |
| `stratos-client`     | Client library: discovery, routing, verification, OAuth scope helpers    |
| `stratos-browser`    | Browser OAuth and DPoP helpers for web apps                              |
| `stratos-feedgen-ng` | Feed generator with encrypted local storage and membership-checked feeds |
| `webapp`             | [Svelte demo client](/guide/webapp) for enrollment and private posting   |
| `lexicons`           | Lexicon definitions for every `zone.stratos.*` method and record         |

The TypeScript feed generator (`stratos-feedgen`) and the AppView indexer
(`stratos-indexer`) are deprecated. They stay in the repository for rollback
and reference.

## Where to go next

**To understand it:**

- [Shared Private Data, Explained Simply](/guide/what-is-stratos): the idea,
  in plain words.
- [Core Concepts](/guide/concepts): boundaries, enrollment, custody, and
  trust.
- [Permissioned Spaces](/architecture/permissioned-spaces): how Stratos
  aligns with the AT Protocol spaces proposal.

**To build with it:**

- [Your First Post](/guide/first-post): a short tutorial.
- [Client Integration](/client/getting-started): add Stratos to your app.
- [Lexicons](/lexicons/): every method and record.

**To run it:**

- [Operator Guide](/operator/overview): deploy and manage a Stratos service.
- [Feed Generator](/operator/feedgen-ng): run the feed generator beside it.

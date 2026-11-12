<script setup>
import BoundaryAccess from '../.vitepress/theme/components/BoundaryAccess.vue'
import EnrollmentFlow from '../.vitepress/theme/components/EnrollmentFlow.vue'
import SpaceDataResidencyAnimation from '../.vitepress/theme/components/SpaceDataResidencyAnimation.vue'
import FeedgenRequestFlow from '../.vitepress/theme/components/FeedgenRequestFlow.vue'
</script>

# Shared Private Data — Explained Simply

Imagine a house party where everyone is in the same room socialising, they're able to gather into
groups to have independent discussions but anyone is able to join them. This is how ATproto data
exposure functions.

Stratos flips the house party on its head where now we have multiple parties going on in _different_
rooms, each with their own theme (music, fandom, etc.) and the person running the party decides who
gets to join. A person could be able to go into any of the rooms or just a subset.

---

## The Problem: Everything Is Public

Social networks built on ATprotocol (like Bluesky) are fully public by default. Every post you write
is visible to anyone, anywhere. That's great for public conversations, but it means there's no way
to share something with just your group, your community, or your close friends — without leaving the
network entirely.

---

## The Stratos Answer

Stratos introduces boundaries — named access scopes that act like club memberships.

When you write a post, you choose one boundary for it, like `cooking` or `hiking`. That is the
room the post is said in. Only people who are enrolled in that same boundary can read it. Everyone
else sees nothing — not even a hint that the post exists.

Most services also have one room that every member is in, usually called `general`. A post there
is for the whole community.

<div class="animation-card">
  <div class="animation-label">
    <span class="step-number">1</span>
    <span>Who can see what — boundary access control</span>
  </div>
  <BoundaryAccess />
</div>

---

## Enrollment

Before you can post or read inside a boundary, you _enroll_ with a Stratos service using your
existing ATprotocol account. This is a one-time OAuth flow.

When you enroll:

1. Stratos checks whether you're on the allowlist (if the operator uses one).
2. Your assigned boundaries are recorded.
3. A small _enrollment record_ is written to your own PDS (your personal data store on the network),
   so anyone can discover which Stratos service you're a member of.

<div class="animation-card">
  <div class="animation-label">
    <span class="step-number">2</span>
    <span>Joining a Stratos service — the enrollment flow</span>
  </div>
  <EnrollmentFlow />
</div>

---

## Where private posts live

Back at the party, think about what happens to the things you bring. Some guests carry a bag
with a lock, and keep their things with them. Others hand their coat to the host, who keeps it
safe in the cloakroom. Both guests are in the same room and hear the same conversation.

Your private posts work the same way. Where they are kept depends on your PDS:

- If your PDS supports protected spaces, it keeps your posts in a protected space of its own.
  Stratos still decides who belongs to that space.
- If your PDS does not support spaces, Stratos keeps the posts for you.

We call this _custody_: who holds your private posts. You do not choose it by hand. Stratos works
it out when you enroll, and both kinds of member share the same rooms.

In either case, a private post is not part of the public feed. Your public enrollment record only
tells apps which Stratos service to ask.

<div class="animation-card">
  <div class="animation-label">
    <span class="step-number">3</span>
    <span>Where a private post is kept</span>
  </div>
  <SpaceDataResidencyAnimation />
</div>

---

## Reading the Room

Posting is half of it. Someone still has to gather the posts of a room into a timeline.

That is the job of the _feed generator_. It visits the members Stratos lists for each room and
collects their posts, wherever they are kept. When you open a feed, it checks the guest list
first, then shows you the posts of the rooms you are in. Nothing else.

<div class="animation-card">
  <div class="animation-label">
    <span class="step-number">4</span>
    <span>Opening a private feed</span>
  </div>
  <FeedgenRequestFlow />
</div>

---

## Putting It Together

| Step                 | What happens                                                           |
| -------------------- | ---------------------------------------------------------------------- |
| You enroll           | Your boundaries are recorded; an enrollment record lands on your PDS   |
| You write a post     | Stratos or a protected space on your PDS stores it                     |
| Someone opens a feed | The app asks the feed generator for posts, on that viewer's behalf     |
| Access is checked    | Is the viewer in the post's boundary? Yes → show it. No → show nothing |
| You see your feed    | Only posts from boundaries you're in appear                            |

---

## Why This Matters

- You keep your AT Protocol identity. Stratos is an extra service, not a
  separate account.
- Access control is enforced on the server. Membership is checked against Stratos's current
  guest list before any content is returned. The app on your phone is never trusted to decide.
- Leaving works. When a member is removed from a boundary, they stop receiving its posts, and
  nobody reads their new ones.
- The signed enrollment record helps apps confirm which Stratos service you
  joined. It does not grant access to posts; current membership decides that.

One honest limit: posts are access-controlled, not end-to-end encrypted. The people who run the
Stratos service and the feed generator can technically read them, the same way an email provider
can. Join communities whose operators you trust.

::: info Operators choose the rules
A community can run its own Stratos service with its own membership criteria — fully independent of
any central authority.
:::

<style scoped>
.animation-card {
  margin: 2rem 0;
  border-radius: 14px;
  overflow: hidden;
  border: 1.5px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.animation-label {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1.1rem;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  border-bottom: 1px solid var(--vp-c-divider);
}

.step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  font-size: 0.78rem;
  font-weight: 700;
  background: var(--vp-c-brand-1);
  color: #fff;
  flex-shrink: 0;
}
</style>

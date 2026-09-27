<script setup>
import BoundaryAccess from '../.vitepress/theme/components/BoundaryAccess.vue'
import EnrollmentFlow from '../.vitepress/theme/components/EnrollmentFlow.vue'
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

When you write a post, you label it with a boundary, like `cooking` or `hiking`. Only people who are
enrolled in that same boundary can read it. Everyone else sees nothing — not even a hint that the
post exists.

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

Your private posts are not published as ordinary public posts. Where they are
stored depends on your PDS:

- If your PDS does not support protected spaces, Stratos stores the post.
- If your PDS supports spaces, it stores the post in a protected space on your
  PDS. Stratos still decides who belongs to that space.
- Your public enrollment record tells apps which Stratos service to contact.
  Apps check access before showing a private post.

In either case, a private post is not part of the public feed.

<div class="animation-card">
  <div class="animation-label">
    <span class="step-number">3</span>
    <span>How apps read private posts</span>
  </div>
  <AppviewHydration />
</div>

---

## Putting It Together

| Step                    | What happens                                                               |
| ----------------------- | -------------------------------------------------------------------------- |
| You enroll              | Your boundaries are recorded; an enrollment record lands on your PDS       |
| You write a post        | Stratos or a protected space on your PDS stores it                         |
| Someone opens your feed | The app requests posts for that viewer                                     |
| Access is checked       | Does the viewer share the post's boundary? Yes → show it. No → deny access |
| You see your feed       | Only posts from boundaries you're in appear                                |

---

## Why This Matters

- You keep your AT Protocol identity. Stratos is an extra service, not a
  separate account.
- Access control is enforced - When your app fetches a post, Stratos validates the requester's
  actual boundary membership before returning any content — no trust is delegated to the client.
- The signed enrollment record helps apps confirm which Stratos service you
  joined. It does not grant access to posts; current membership decides that.

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

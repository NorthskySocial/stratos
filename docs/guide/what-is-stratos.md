<script setup>
import BoundaryAccess from '../.vitepress/theme/components/BoundaryAccess.vue'
import EnrollmentFlow from '../.vitepress/theme/components/EnrollmentFlow.vue'
import AppviewHydration from '../.vitepress/theme/components/AppviewHydration.vue'
</script>

# Shared Private Data — Explained Simply

Imagine a house party where everyone is in the same room socialising, they're able to gather into groups to have independent discussions but anyone is able to join them. This is how ATproto data exposure functions.

Stratos flips the house party on its head where now we have multiple parties going on in _different_ rooms, each with their own theme (music, fandom, etc.) and the person running the party decides who gets to join. A person could be able to go into any of the rooms or just a subset.

---

## The Problem: Everything Is Public

Social networks built on ATProtocol (like Bluesky) are fully public by default. Every post you write is visible to anyone, anywhere. That's great for public conversations, but it means there's no way to share something with just your team, your community, or your close friends — without leaving the network entirely.

---

## The Stratos Answer: Boundaries

Stratos introduces boundaries — named access scopes that act like club memberships.

When you write a post, you label it with a boundary, like `fanart` or `writers`. Only people who are enrolled in that same boundary can read it. Everyone else sees nothing — not even a hint that the post exists.

<div class="animation-card">
  <div class="animation-label">
    <span class="step-number">1</span>
    <span>Who can see what — boundary access control</span>
  </div>
  <BoundaryAccess />
</div>

---

## Enrollment

Before you can post or read inside a boundary, you **enroll** with a Stratos service using your existing ATProtocol account. This is a one-time OAuth flow.

When you enroll:

1. Stratos checks whether you're on the allowlist (if the operator uses one).
2. Your assigned boundaries are recorded.
3. A small **enrollment record** is written to your own PDS (your personal data store on the network), so anyone can discover which Stratos service you're a member of.

<div class="animation-card">
  <div class="animation-label">
    <span class="step-number">2</span>
    <span>Joining a Stratos service — the enrollment flow</span>
  </div>
  <EnrollmentFlow />
</div>

---

## Private Data: A tale of two records

When you post something via Stratos, it is stored within the service but discoverable via the Firehose using a source field pattern:

- The full post (with your actual text, attachments, and boundary label) is stored securely inside Stratos.
- A tiny stub record is written to your public PDS. The stub contains no content — only a pointer that says _"the real version of this lives over here, and you'll need permission to read it"_.

This means the network can still index and route your posts using the same infrastructure as public content on our PDS, but the actual content never leaks out.

<div class="animation-card">
  <div class="animation-label">
    <span class="step-number">3</span>
    <span>How apps read private posts — AppView hydration</span>
  </div>
  <AppviewHydration />
</div>

---

## Putting It Together

| Step                    | What happens                                                               |
| ----------------------- | -------------------------------------------------------------------------- |
| You enroll              | Your boundaries are recorded; an enrollment record lands on your PDS       |
| You write a post        | Full content stored in Stratos; a stub goes to your PDS                    |
| Someone opens your feed | The app fetches the stub, sees the pointer, asks Stratos for the full post |
| Stratos checks          | Does the requester share your boundary? Yes → full post. No → nothing      |
| You see your feed       | Only posts from boundaries you're in appear                                |

---

## Why This Matters

- Your posts live in your namespace (`at://your-did/zone.stratos.feed.post/...`), not in a closed silo.
- You keep your identity - Stratos is an add-on layer, not a separate account.
- Access control is enforced - When your app fetches a post, Stratos validates the requester's actual boundary membership before returning any content — no trust is delegated to the client.
- Attestations are for _discovery_, not enforcement - The service attestation in your enrollment record is a public signal: it lets any app confirm that you are enrolled with a specific Stratos service and what boundaries you were assigned at signing time. This enables offline verification without hitting the live service on every request.

::: info Operators choose the rules
A community can run its own Stratos service with its own membership criteria — fully independent of any central authority
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

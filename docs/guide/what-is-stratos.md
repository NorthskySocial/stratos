<script setup>
import BoundaryAccess from '../.vitepress/theme/components/BoundaryAccess.vue'
import EnrollmentFlow from '../.vitepress/theme/components/EnrollmentFlow.vue'
import AppviewHydration from '../.vitepress/theme/components/AppviewHydration.vue'
</script>

# Shared Private Data — Explained Simply

Imagine a school where students can post notes on a giant public bulletin board that everyone in the world can read. That's what most social networks are like today.

**Stratos adds a second kind of board** — one with a lock. Only students in the same club can read those notes, even though they still live in the same school.

---

## The Problem: Everything Is Public

Social networks built on ATProtocol (like Bluesky) are **fully public by default**. Every post you write is visible to anyone, anywhere. That's great for public conversations, but it means there's no way to share something with just your team, your community, or your close friends — without leaving the network entirely.

---

## The Stratos Answer: Boundaries

Stratos introduces **boundaries** — named access scopes that act like club memberships.

When you write a post, you label it with a boundary, like `fanart` or `writers`. Only people who are enrolled in that same boundary can read it. Everyone else sees nothing — not even a hint that the post exists.

<div class="animation-card">
  <div class="animation-label">
    <span class="step-number">1</span>
    <span>Who can see what — boundary access control</span>
  </div>
  <BoundaryAccess />
</div>

---

## Joining: Enrollment

Before you can post or read inside a boundary, you **enroll** with a Stratos service using your existing ATProtocol account. This is a one-time OAuth flow — the same "Sign in with…" button you already know.

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

## The Clever Part: Two Copies

When you post something private, Stratos doesn't just hide it from a database. It uses a technique called the **source field pattern**:

- The **full post** (with your actual text, attachments, and boundary label) is stored securely inside Stratos.
- A tiny **stub record** is written to your public PDS. The stub contains no content — only a pointer that says *"the real version of this lives over here, and you'll need permission to read it"*.

This means the network can still index and route your posts using the same infrastructure as public content, but the actual content never leaks out.

<div class="animation-card">
  <div class="animation-label">
    <span class="step-number">3</span>
    <span>How apps read private posts — AppView hydration</span>
  </div>
  <AppviewHydration />
</div>

---

## Putting It Together

| Step | What happens |
|------|-------------|
| You enroll | Your boundaries are recorded; an enrollment record lands on your PDS |
| You write a post | Full content stored in Stratos; a stub goes to your PDS |
| Someone opens your feed | The app fetches the stub, sees the pointer, asks Stratos for the full post |
| Stratos checks | Does the requester share your boundary? Yes → full post. No → nothing |
| You see your feed | Only posts from boundaries you're in appear |

---

## Why This Matters

- **It's still decentralised.** Your posts live in your namespace (`at://your-did/zone.stratos.feed.post/...`), not in a closed silo.
- **You keep your identity.** Same handle, same keys, same social graph — Stratos is an add-on layer, not a separate account.
- **Access control is cryptographic.** Boundaries are enforced by the Stratos service with signed attestations, not by hoping an app follows rules.
- **Operators choose the rules.** A community can run its own Stratos service with its own membership criteria — fully independent of any central authority.

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

---
title: Lexicon Reference
audience: App developers and protocol implementers
type: Reference
status: current
---

<script setup>
import { data } from './lexicons.data.js'
import LexiconGroup from '../.vitepress/theme/components/LexiconGroup.vue'

function ns(name) {
  return data.namespaces.find(n => n.name === name)?.lexicons ?? []
}
</script>

# Lexicon Reference

Every lexicon under `lexicons/zone/stratos/` in the repository. A lexicon describes an XRPC method,
a record type, or a shared definition in the `zone.stratos.*` namespace. The page is generated from
the JSON files at build time.

A lexicon on this page is a contract, not a promise that one service serves it. The Stratos service
serves most methods. The feed generator serves `zone.stratos.feedgen.*`. The
[API methods](/reference/api#method-index) lists what the Stratos service serves and the
authentication each method accepts.

The space type `zone.stratos.space.feed` is not on this page. Its lexicon lives in
`lexicons-spaces/zone/stratos/space/feed.json`. Stratos publishes it as a
`com.atproto.lexicon.schema` record, and a PDS resolves it before it grants a space scope.

<div class="lex-badge-legend">
  <span class="badge-item"><span class="lb badge-query">GET</span> Query — read-only XRPC call</span>
  <span class="badge-item"><span class="lb badge-procedure">POST</span> Procedure — write XRPC call</span>
  <span class="badge-item"><span class="lb badge-subscription">WS</span> Subscription — WebSocket stream</span>
  <span class="badge-item"><span class="lb badge-record">RECORD</span> Record type stored in repos</span>
  <span class="badge-item"><span class="lb badge-object">OBJECT</span> Object type used inside records</span>
  <span class="badge-item"><span class="lb badge-defs">DEFS</span> Shared type definitions</span>
</div>

## Core Definitions

<LexiconGroup :lexicons="ns('core')" />

## Actor

<LexiconGroup :lexicons="ns('actor')" />

## Admin

<LexiconGroup :lexicons="ns('admin')" />

## Boundary

<LexiconGroup :lexicons="ns('boundary')" />

## Embed

<LexiconGroup :lexicons="ns('embed')" />

## Enrollment

<LexiconGroup :lexicons="ns('enrollment')" />

## Feed

<LexiconGroup :lexicons="ns('feed')" />

## Feed Generator

<LexiconGroup :lexicons="ns('feedgen')" />

## Identity

<LexiconGroup :lexicons="ns('identity')" />

## Repository

<LexiconGroup :lexicons="ns('repo')" />

## Server

<LexiconGroup :lexicons="ns('server')" />

## Space

<LexiconGroup :lexicons="ns('space')" />

## Sync

<LexiconGroup :lexicons="ns('sync')" />

<style scoped>
.lex-badge-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  padding: 14px 18px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  margin: 1.5rem 0 2rem;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.badge-item { display: flex; align-items: center; gap: 8px; }
.lb {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .06em;
  padding: 2px 7px;
  border-radius: 5px;
}
.badge-query       { background: #40DAC4; color: #0d2420; }
.badge-procedure   { background: #9145EC; color: #fff; }
.badge-subscription{ background: #7780DC; color: #fff; }
.badge-record      { background: #2AFFBA; color: #0d2420; }
.badge-defs        { background: #59B2CF; color: #0d1f2d; }
</style>

<style>
/* Not scoped: the entry component renders this badge and has no color for it. */
.badge-object { background: #E0B45C; color: #2d2108; }
</style>

---
title: Lexicon Reference
---

<script setup>
import { data } from './lexicons.data.js'
import LexiconGroup from '../.vitepress/theme/components/LexiconGroup.vue'

function ns(name) {
  return data.namespaces.find(n => n.name === name)?.lexicons ?? []
}
</script>

# Lexicon Reference

All AT Protocol lexicons defined by the Stratos service. Lexicons describe every XRPC method, record type, and shared definition available in this namespace (`zone.stratos.*`).

<div class="lex-badge-legend">
  <span class="badge-item"><span class="lb badge-query">GET</span> Query — read-only XRPC call</span>
  <span class="badge-item"><span class="lb badge-procedure">POST</span> Procedure — write XRPC call</span>
  <span class="badge-item"><span class="lb badge-subscription">WS</span> Subscription — WebSocket stream</span>
  <span class="badge-item"><span class="lb badge-record">RECORD</span> Record type stored in repos</span>
  <span class="badge-item"><span class="lb badge-defs">DEFS</span> Shared type definitions</span>
</div>

## Core Definitions

<LexiconGroup :lexicons="ns('core')" />

## Actor

<LexiconGroup :lexicons="ns('actor')" />

## Boundary

<LexiconGroup :lexicons="ns('boundary')" />

## Enrollment

<LexiconGroup :lexicons="ns('enrollment')" />

## Feed

<LexiconGroup :lexicons="ns('feed')" />

## Identity

<LexiconGroup :lexicons="ns('identity')" />

## Repository

<LexiconGroup :lexicons="ns('repo')" />

## Server

<LexiconGroup :lexicons="ns('server')" />

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

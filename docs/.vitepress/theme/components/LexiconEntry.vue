<template>
  <div class="lex-entry" :class="'lex-type-' + mainType">
    <div class="lex-header">
      <span class="lex-badge" :class="'badge-' + mainType">{{ badgeLabel }}</span>
      <span class="lex-id">{{ id }}</span>
    </div>

    <p v-if="description" class="lex-desc">{{ description }}</p>

    <!-- Parameters (query / subscription) -->
    <template v-if="parameters">
      <h4 class="lex-section-title">Parameters</h4>
      <div class="lex-table-wrap">
        <table class="lex-table">
          <thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
          <tbody>
            <tr v-for="(prop, name) in parameters.properties" :key="name">
              <td><code>{{ name }}</code></td>
              <td><span class="type-pill">{{ formatType(prop) }}</span></td>
              <td><span :class="isRequired(parameters, name) ? 'req-yes' : 'req-no'">{{ isRequired(parameters, name) ? '✓' : '—' }}</span></td>
              <td class="lex-note">{{ prop.description ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Input body (procedure) -->
    <template v-if="inputSchema">
      <h4 class="lex-section-title">Request Body <span class="enc-badge">{{ inputEncoding }}</span></h4>
      <div class="lex-table-wrap">
        <table class="lex-table">
          <thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
          <tbody>
            <tr v-for="(prop, name) in inputSchema.properties" :key="name">
              <td><code>{{ name }}</code></td>
              <td><span class="type-pill">{{ formatType(prop) }}</span></td>
              <td><span :class="isRequired(inputSchema, name) ? 'req-yes' : 'req-no'">{{ isRequired(inputSchema, name) ? '✓' : '—' }}</span></td>
              <td class="lex-note">{{ prop.description ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Output (query / procedure) -->
    <template v-if="outputSchema">
      <h4 class="lex-section-title">Response <span class="enc-badge">{{ outputEncoding }}</span></h4>
      <div class="lex-table-wrap">
        <table class="lex-table">
          <thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
          <tbody>
            <tr v-for="(prop, name) in outputSchema.properties" :key="name">
              <td><code>{{ name }}</code></td>
              <td><span class="type-pill">{{ formatType(prop) }}</span></td>
              <td><span :class="isRequired(outputSchema, name) ? 'req-yes' : 'req-no'">{{ isRequired(outputSchema, name) ? '✓' : '—' }}</span></td>
              <td class="lex-note">{{ prop.description ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Record schema (record type) -->
    <template v-if="recordSchema">
      <h4 class="lex-section-title">Record Schema</h4>
      <div class="lex-table-wrap">
        <table class="lex-table">
          <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
          <tbody>
            <tr v-for="(prop, name) in recordSchema.properties" :key="name">
              <td><code>{{ name }}</code></td>
              <td><span class="type-pill">{{ formatType(prop) }}</span></td>
              <td><span :class="isRequired(recordSchema, name) ? 'req-yes' : 'req-no'">{{ isRequired(recordSchema, name) ? '✓' : '—' }}</span></td>
              <td class="lex-note">{{ prop.description ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Message schema (subscription) -->
    <template v-if="messageSchema">
      <h4 class="lex-section-title">Message Types</h4>
      <div class="lex-refs-list">
        <span v-for="ref in messageSchema.refs" :key="ref" class="ref-chip">{{ formatRef(ref) }}</span>
      </div>
    </template>

    <!-- Defs (non-main definitions in the lexicon) -->
    <template v-if="extraDefs.length > 0">
      <h4 class="lex-section-title">Type Definitions</h4>
      <div v-for="def in extraDefs" :key="def.name" class="lex-subdef">
        <div class="subdef-title"><code>{{ def.name }}</code> <span v-if="def.def.description" class="subdef-desc">— {{ def.def.description }}</span></div>
        <div v-if="def.def.properties" class="lex-table-wrap">
          <table class="lex-table lex-table-sm">
            <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
            <tbody>
              <tr v-for="(prop, name) in def.def.properties" :key="name">
                <td><code>{{ name }}</code></td>
                <td><span class="type-pill">{{ formatType(prop) }}</span></td>
                <td><span :class="isRequired(def.def, name) ? 'req-yes' : 'req-no'">{{ isRequired(def.def, name) ? '✓' : '—' }}</span></td>
                <td class="lex-note">{{ prop.description ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- Errors -->
    <template v-if="errors && errors.length">
      <h4 class="lex-section-title">Errors</h4>
      <div class="lex-errors">
        <div v-for="err in errors" :key="err.name" class="lex-error-row">
          <code class="err-name">{{ err.name }}</code>
          <span v-if="err.description" class="err-desc">{{ err.description }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
const props = defineProps({
  id: String,
  mainDef: Object,
  allDefs: Object,
})

const mainType = props.mainDef?.type ?? 'defs'

const BADGE_LABELS = {
  query: 'GET',
  procedure: 'POST',
  subscription: 'WS',
  record: 'RECORD',
  defs: 'DEFS',
}
const badgeLabel = BADGE_LABELS[mainType] ?? mainType.toUpperCase()

const description = props.mainDef?.description ?? ''

const parameters = props.mainDef?.parameters ?? null
const inputSchema = props.mainDef?.input?.schema ?? null
const inputEncoding = props.mainDef?.input?.encoding ?? ''
const outputSchema = props.mainDef?.output?.schema ?? null
const outputEncoding = props.mainDef?.output?.encoding ?? ''
const recordSchema = props.mainDef?.record ?? null
const messageSchema = props.mainDef?.message?.schema ?? null
const errors = props.mainDef?.errors ?? null

const extraDefs = Object.entries(props.allDefs ?? {})
  .filter(([name]) => name !== 'main')
  .map(([name, def]) => ({ name, def }))

function isRequired(schema, name) {
  return Array.isArray(schema?.required) && schema.required.includes(name)
}

function formatType(prop) {
  if (!prop) return ''
  if (prop.type === 'array') {
    const item = prop.items
    if (!item) return 'array'
    return `${formatType(item)}[]`
  }
  if (prop.type === 'ref') return shortRef(prop.ref ?? '')
  if (prop.type === 'union') {
    const refs = prop.refs ?? []
    return refs.map(r => shortRef(r)).join(' | ')
  }
  if (prop.format) return `${prop.type} (${prop.format})`
  return prop.type ?? ''
}

function shortRef(ref) {
  if (ref.startsWith('#')) return ref
  const parts = ref.split('.')
  const last = parts[parts.length - 1]
  if (ref.includes('#')) {
    const [, frag] = ref.split('#')
    return `#${frag}`
  }
  return last
}

function formatRef(ref) {
  if (ref.startsWith('#')) return ref.slice(1)
  return ref.split('.').pop() ?? ref
}
</script>

<style scoped>
.lex-entry {
  border: 1.5px solid var(--vp-c-divider);
  border-radius: 12px;
  margin: 1.5rem 0;
  overflow: hidden;
}
.lex-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-divider);
}
.lex-badge {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .06em;
  padding: 3px 9px;
  border-radius: 6px;
  flex-shrink: 0;
}
.badge-query       { background: #40DAC4; color: #0d2420; }
.badge-procedure   { background: #9145EC; color: #fff; }
.badge-subscription{ background: #7780DC; color: #fff; }
.badge-record      { background: #2AFFBA; color: #0d2420; }
.badge-defs        { background: #59B2CF; color: #0d1f2d; }

.lex-id {
  font-family: var(--vp-font-family-mono, monospace);
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}
.lex-desc {
  margin: 12px 18px 0;
  font-size: 14px;
  color: var(--vp-c-text-2);
  line-height: 1.6;
}
.lex-section-title {
  margin: 16px 18px 8px;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--vp-c-text-2);
}
.lex-table-wrap {
  margin: 0 18px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: auto;
}
.lex-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.lex-table th {
  background: var(--vp-c-bg-alt);
  padding: 7px 12px;
  text-align: left;
  font-weight: 600;
  border-bottom: 1px solid var(--vp-c-divider);
  white-space: nowrap;
}
.lex-table td {
  padding: 7px 12px;
  border-bottom: 1px solid var(--vp-c-divider);
  vertical-align: top;
}
.lex-table tr:last-child td { border-bottom: none; }
.lex-table code { background: var(--vp-c-bg-soft); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
.lex-table-sm th, .lex-table-sm td { padding: 5px 10px; font-size: 12px; }
.lex-note { color: var(--vp-c-text-2); font-size: 12px; }
.type-pill {
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  border-radius: 5px;
  padding: 1px 6px;
  font-size: 11.5px;
  font-family: var(--vp-font-family-mono, monospace);
  white-space: nowrap;
  color: var(--vp-c-brand-1);
}
.req-yes { color: #2AFFBA; font-weight: 700; }
.req-no  { color: var(--vp-c-text-3); }
.enc-badge {
  font-size: 10px;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 400;
  letter-spacing: normal;
  text-transform: none;
  font-family: var(--vp-font-family-mono, monospace);
  margin-left: 6px;
}
.lex-refs-list {
  margin: 0 18px 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ref-chip {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-brand-soft, #7780DC44);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 12px;
  font-family: var(--vp-font-family-mono, monospace);
  color: var(--vp-c-brand-1);
}
.lex-subdef {
  margin: 0 18px 12px;
}
.subdef-title {
  font-size: 13px;
  margin-bottom: 6px;
}
.subdef-title code { background: var(--vp-c-bg-soft); padding: 2px 6px; border-radius: 4px; color: var(--vp-c-brand-1); }
.subdef-desc { color: var(--vp-c-text-2); }
.lex-errors {
  margin: 0 18px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lex-error-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}
.err-name { background: #9145EC22; color: #b27cf5; padding: 2px 7px; border-radius: 5px; }
.err-desc { color: var(--vp-c-text-2); }
</style>

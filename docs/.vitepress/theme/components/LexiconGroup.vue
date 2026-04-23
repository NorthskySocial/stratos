<template>
  <template v-for="lex in lexicons" :key="lex.id">
    <LexiconEntry
      :id="lex.id"
      :all-defs="lex.allDefs"
      :main-def="lex.mainDef"
    />
  </template>
</template>

<script setup>
import LexiconEntry from './LexiconEntry.vue'

defineProps({
  lexicons: Array,
})
</script>

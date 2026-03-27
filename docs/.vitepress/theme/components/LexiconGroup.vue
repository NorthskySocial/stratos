<template>
  <template v-for="lex in lexicons" :key="lex.id">
    <LexiconEntry
      :id="lex.id"
      :main-def="lex.mainDef"
      :all-defs="lex.allDefs"
    />
  </template>
</template>

<script setup>
import LexiconEntry from './LexiconEntry.vue'

defineProps({
  lexicons: Array,
})
</script>

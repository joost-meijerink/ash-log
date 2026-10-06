<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import SectionHeading from '@/components/common/SectionHeading.vue'
import WikiIcon from '@/components/common/WikiIcon.vue'
import type { SearchEntry } from '@/lib/map-filter'
import MapGlyph from './MapGlyph.vue'

/** Points matching the search. A click flies there and opens the card. */
const props = defineProps<{
  hits: SearchEntry[]
  total: number
}>()

const emit = defineEmits<{ select: [pointId: string] }>()

const more = computed(() => props.total - props.hits.length)
</script>

<template>
  <section aria-labelledby="map-search-results" class="px-3 pt-2 pb-3">
    <SectionHeading id="map-search-results" as="h2" title="Plekken" :count="total" />
    <ul v-if="hits.length" class="mt-1 flex flex-col" role="list">
      <li v-for="hit in hits" :key="hit.point.id">
        <button
          type="button"
          class="group/hit flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none hover:bg-line-dark/45 focus-visible:ring-2 focus-visible:ring-gold/70"
          @click="emit('select', hit.point.id)"
        >
          <WikiIcon :file="hit.point.icon ?? hit.category.icon" :size="20">
            <template #fallback><MapGlyph :glyph="hit.category.group" :size="18" /></template>
          </WikiIcon>
          <span class="flex min-w-0 flex-1 flex-col">
            <span lang="en" class="truncate text-[0.95rem] text-text-light">{{ hit.title }}</span>
            <span lang="en" class="truncate text-xs text-muted-light">
              <template v-if="hit.title !== hit.category.label">{{ hit.category.label }}</template>
              <template v-if="hit.title !== hit.category.label && hit.point.region"> · </template>
              <template v-if="hit.point.region">{{ hit.point.region }}</template>
            </span>
          </span>
          <ChevronRight aria-hidden="true" class="size-4 shrink-0 text-muted-light/70 transition-colors group-hover/hit:text-gold" />
        </button>
      </li>
    </ul>
    <p v-if="more > 0" class="px-2 pt-1 text-sm text-muted-light">Nog {{ more }} meer. Typ verder om te verfijnen.</p>
    <p v-if="total === 0" class="px-2 pt-1 text-sm text-muted-light">Geen losse plekken met deze naam.</p>
  </section>
</template>

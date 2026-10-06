<script setup lang="ts">
import { computed, ref, watch, type HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { iconFileName } from '@/lib/ids'

/**
 * Icon downloaded by the sync into /public/wiki-img/icons/. When the file is missing (not synced
 * yet, or the download failed) it shows the `fallback` slot, or a quiet diamond outline.
 */
const props = withDefaults(
  defineProps<{
    /** File name as stored on MapCategory.icon / MapPoint.icon, e.g. 'Gold_Ore.png'. 'File:' prefixes and spaces are fine. */
    file?: string | null
    /** Alt text. Default '' (decorative); pass a name when the icon stands alone. */
    alt?: string
    /** Square size in px. Default 24. */
    size?: number
    class?: HTMLAttributes['class']
  }>(),
  { file: undefined, alt: '', size: 24 },
)

const failed = ref(false)
watch(
  () => props.file,
  () => {
    failed.value = false
  },
)

const src = computed(() => (props.file ? `/wiki-img/icons/${encodeURIComponent(iconFileName(props.file))}` : null))
</script>

<template>
  <span
    data-slot="wiki-icon"
    :class="cn('inline-grid shrink-0 place-content-center', props.class)"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <img
      v-if="src && !failed"
      :src="src"
      :alt="alt"
      :width="size"
      :height="size"
      loading="lazy"
      decoding="async"
      class="size-full object-contain"
      @error="failed = true"
    />
    <slot v-else name="fallback">
      <svg
        :width="Math.round(size * 0.6)"
        :height="Math.round(size * 0.6)"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linejoin="round"
        class="opacity-45"
        :role="alt ? 'img' : undefined"
        :aria-label="alt || undefined"
        :aria-hidden="alt ? undefined : 'true'"
      >
        <path d="M12 3 21 12 12 21 3 12Z" />
        <path d="M12 8.5 15.5 12 12 15.5 8.5 12Z" />
      </svg>
    </slot>
  </span>
</template>

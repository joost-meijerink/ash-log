<script setup lang="ts">
import { nextTick, ref, type HTMLAttributes } from 'vue'
import { Check } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * A checklist row of at least 44px: checkbox, label and an optional meta column.
 * The whole row is a <label> around a native checkbox, so clicking anywhere toggles it,
 * Tab focuses it and Space toggles it. Links or buttons inside the row keep working
 * without toggling. Use with v-model:checked.
 */
const props = withDefaults(
  defineProps<{
    /** Checked state (v-model:checked). */
    checked: boolean
    disabled?: boolean
    /** Strike through and dim the label when checked. Default true. */
    strike?: boolean
    /** Accessible name when the label slot is not plain text. */
    ariaLabel?: string
    tone?: Tone
    class?: HTMLAttributes['class']
  }>(),
  { disabled: false, strike: true, ariaLabel: undefined, tone: undefined },
)

const emit = defineEmits<{
  /** New checked state after a click or Space. */
  'update:checked': [value: boolean]
}>()

const tone = useTone(() => props.tone)
const input = ref<HTMLInputElement | null>(null)

function onChange(event: Event) {
  const next = (event.target as HTMLInputElement).checked
  emit('update:checked', next)
  // Stay controlled: if the parent does not accept the change, snap back to the prop.
  void nextTick(() => {
    if (input.value && input.value.checked !== props.checked) input.value.checked = props.checked
  })
}
</script>

<template>
  <label
    data-slot="check-row"
    :data-checked="checked || undefined"
    :data-tone="tone"
    :class="
      cn(
        'group flex min-h-11 items-start gap-3 rounded-md px-2.5 py-[11px] font-sans text-[0.975rem] leading-snug transition-colors',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        tone === 'dark' ? 'text-text-light hover:bg-line-dark/40' : 'text-text-parchment hover:bg-parchment-deep/70',
        props.class,
      )
    "
  >
    <span class="relative mt-px grid size-5 shrink-0 place-content-center">
      <input
        ref="input"
        type="checkbox"
        :checked="checked"
        :disabled="disabled"
        :aria-label="ariaLabel"
        :class="
          cn(
            'peer absolute inset-0 m-0 size-5 cursor-[inherit] appearance-none rounded-[4px] border-[1.5px] transition-[background-color,border-color,box-shadow] outline-none',
            'focus-visible:ring-2 focus-visible:ring-offset-2',
            tone === 'dark'
              ? 'border-muted-light/70 bg-ink/60 group-hover:border-gold checked:border-gold checked:bg-gold focus-visible:ring-gold focus-visible:ring-offset-leather'
              : 'border-gold-ink/60 bg-[#f6eedb] group-hover:border-gold-ink checked:border-gold-ink checked:bg-gold-ink focus-visible:ring-gold-ink focus-visible:ring-offset-parchment',
          )
        "
        @change="onChange"
      />
      <Check
        aria-hidden="true"
        :stroke-width="3"
        :class="
          cn(
            'pointer-events-none relative size-3.5 opacity-0 transition-opacity peer-checked:opacity-100',
            tone === 'dark' ? 'text-ink' : 'text-parchment',
          )
        "
      />
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span
        data-slot="check-row-label"
        :class="
          cn(
            'transition-[color,opacity]',
            strike &&
              checked &&
              (tone === 'dark'
                ? 'text-muted-light line-through decoration-gold/50'
                : 'text-text-parchment/55 line-through decoration-gold-ink/45'),
          )
        "
      >
        <slot />
      </span>
      <span
        v-if="$slots.note"
        :class="cn('text-sm', tone === 'dark' ? 'text-muted-light' : 'text-text-parchment/65')"
      >
        <slot name="note" />
      </span>
    </span>
    <span
      v-if="$slots.meta"
      :class="
        cn(
          'shrink-0 self-start pt-px text-sm tabular-nums',
          tone === 'dark' ? 'text-muted-light' : 'text-text-parchment/70',
        )
      "
    >
      <slot name="meta" />
    </span>
  </label>
</template>

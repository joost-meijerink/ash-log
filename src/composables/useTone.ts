// Surface tone for UI pieces: dark leather (default) or parchment.
// ParchmentPanel provides 'parchment' to everything inside it, so a Button, Checkbox,
// CheckRow or ProgressBar placed on a parchment panel picks the right colours without props.
// Dialog and tooltip content reset the tone, because they render on their own surface.

import { computed, inject, provide, toValue, type ComputedRef, type InjectionKey, type MaybeRefOrGetter } from 'vue'

export type Tone = 'dark' | 'parchment'

const TONE_KEY: InjectionKey<ComputedRef<Tone>> = Symbol('ashenfall-tone')

/** Makes `tone` the default for every tone-aware component below the caller. */
export function provideTone(tone: MaybeRefOrGetter<Tone>): ComputedRef<Tone> {
  const value = computed(() => toValue(tone))
  provide(TONE_KEY, value)
  return value
}

/** Resolves a component's tone: explicit prop first, then the nearest provider, then 'dark'. */
export function useTone(explicit?: MaybeRefOrGetter<Tone | undefined>): ComputedRef<Tone> {
  const inherited = inject(TONE_KEY, null)
  return computed(() => toValue(explicit) ?? inherited?.value ?? 'dark')
}

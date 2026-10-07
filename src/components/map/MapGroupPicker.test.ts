// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, ref } from 'vue'
import type { MapCategory } from '@/lib/types'
import { provideMapContext, type MapContext } from '@/composables/useMapContext'
import MapGroupPicker from './MapGroupPicker.vue'

const category: MapCategory = { id: 'weathered-diary', label: 'Weathered Diary', group: 'lore', sources: [], count: 1 }

function mountPicker() {
  const groupOverride = {
    saving: ref<string | null>(null),
    message: ref(null),
    readOnly: computed(() => false),
    offline: computed(() => false),
    manualGroup: () => undefined,
    setGroup: vi.fn(async () => {}),
    dismiss: vi.fn(),
  }
  const Host = defineComponent({
    setup() {
      provideMapContext({ groupOverride } as unknown as MapContext)
      return () => h(MapGroupPicker, { category })
    },
  })
  return mount(Host)
}

describe('MapGroupPicker', () => {
  // jsdom has no layout, so it cannot measure the overflow itself. WebKit draws the selected
  // option's text past the invisible select ("Automatic: Lore" sticks out of the 44px box), which
  // made the filter list scroll sideways. Check by hand in Safari or Ash Log.app: the sidebar's
  // scrollWidth must equal its clientWidth.
  it('clips the invisible select, so its text cannot widen the filter list', () => {
    const wrapper = mountPicker()
    const span = wrapper.get('[data-slot="map-group-picker"]')
    expect(span.classes()).toContain('overflow-hidden')
    expect(span.classes()).toContain('w-11')
    expect(wrapper.get('select').classes()).toContain('overflow-hidden')
  })

  it('names the current group in the first option and the label', () => {
    const wrapper = mountPicker()
    expect(wrapper.get('option').text()).toBe('Automatic: Lore')
    expect(wrapper.get('select').attributes('aria-label')).toContain('Group for Weathered Diary')
  })
})

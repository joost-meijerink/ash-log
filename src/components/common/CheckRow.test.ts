// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import CheckRow from './CheckRow.vue'
import ParchmentPanel from './ParchmentPanel.vue'

describe('CheckRow', () => {
  it('renders label and meta slots and reflects the checked prop', () => {
    const wrapper = mount(CheckRow, {
      props: { checked: true },
      slots: { default: 'Kill 4 rats', meta: 'x4' },
    })
    const input = wrapper.get('input[type="checkbox"]')
    expect((input.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('Kill 4 rats')
    expect(wrapper.text()).toContain('x4')
    expect(wrapper.attributes('data-checked')).toBe('true')
    expect(wrapper.get('[data-slot="check-row-label"]').classes()).toContain('line-through')
  })

  it('emits update:checked when the checkbox changes', async () => {
    const wrapper = mount(CheckRow, { props: { checked: false }, slots: { default: 'Step' } })
    await wrapper.get('input').setValue(true)
    expect(wrapper.emitted('update:checked')).toEqual([[true]])
  })

  it('toggles when the row label is clicked, and works with v-model', async () => {
    const Host = defineComponent({
      setup() {
        const checked = ref(false)
        return () =>
          h('div', [
            h(CheckRow, { checked: checked.value, 'onUpdate:checked': (v: boolean) => (checked.value = v) }, () => 'Step'),
            h('output', String(checked.value)),
          ])
      },
    })
    const wrapper = mount(Host, { attachTo: document.body })
    await wrapper.get('[data-slot="check-row-label"]').trigger('click')
    expect(wrapper.get('output').text()).toBe('true')
    expect((wrapper.get('input').element as HTMLInputElement).checked).toBe(true)
    await wrapper.get('[data-slot="check-row-label"]').trigger('click')
    expect(wrapper.get('output').text()).toBe('false')
    wrapper.unmount()
  })

  it('snaps back when the parent ignores the change (controlled)', async () => {
    const wrapper = mount(CheckRow, { props: { checked: false }, slots: { default: 'Step' } })
    const input = wrapper.get('input').element as HTMLInputElement
    input.checked = true
    await wrapper.get('input').trigger('change')
    await wrapper.vm.$nextTick()
    expect(input.checked).toBe(false)
  })

  it('does not toggle when disabled', async () => {
    const wrapper = mount(CheckRow, { props: { checked: false, disabled: true }, slots: { default: 'Step' } })
    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
  })

  it('uses the parchment tone inside a ParchmentPanel, dark tone by default', () => {
    const dark = mount(CheckRow, { props: { checked: false }, slots: { default: 'Step' } })
    expect(dark.attributes('data-tone')).toBe('dark')
    const onPanel = mount(ParchmentPanel, {
      slots: { default: () => h(CheckRow, { checked: false }, () => 'Step') },
    })
    expect(onPanel.get('[data-slot="check-row"]').attributes('data-tone')).toBe('parchment')
  })
})

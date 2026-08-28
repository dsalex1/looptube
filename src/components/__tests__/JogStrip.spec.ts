import JogStrip from '@/components/JogStrip.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

const jog = (modelValue: number) =>
  mount(JogStrip, { props: { modelValue, step: 0.01, min: 0.5, max: 2, label: 'x', resetTo: 1 } })

const tap = async (w: ReturnType<typeof jog>, x = 10) => {
  await w.trigger('pointerdown', { clientX: x, pointerType: 'touch' })
  await w.trigger('pointerup', { clientX: x, pointerType: 'touch' })
}

const latest = (w: ReturnType<typeof jog>) => w.emitted('update:modelValue')?.at(-1)?.[0]

describe('JogStrip', () => {
  it('resets on a double tap, which touch does not deliver as dblclick', async () => {
    const w = jog(1.1)
    await tap(w)
    expect(latest(w)).toBeUndefined()
    await tap(w)
    expect(latest(w)).toBe(1)
  })

  it('does not treat a drag ending near a tap as the second tap', async () => {
    const w = jog(1.1)
    await tap(w)
    await w.trigger('pointerdown', { clientX: 10, pointerType: 'touch' })
    await w.trigger('pointermove', { clientX: 50, pointerType: 'touch' })
    await w.trigger('pointerup', { clientX: 50, pointerType: 'touch' })
    await tap(w)
    expect(latest(w)).not.toBe(1)
  })

})

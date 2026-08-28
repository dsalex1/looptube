<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  /** how far one pixel of drag moves the value */
  step: number
  min: number
  max: number
  label: string
  sub?: string
  /** double-click snaps back to this */
  resetTo?: number
}>()

const value = defineModel<number>({ required: true })

const PIXELS_PER_STEP = 4 // drag feel: a step every few pixels

const dragging = ref(false)
let fromX = 0
let fromValue = 0

const clamp = (v: number) => Math.max(props.min, Math.min(props.max, v))
// keep the value on exact multiples of the step, so 0.01 steps never drift to 0.009999
const quantise = (v: number) => Math.round(clamp(v) / props.step) * props.step

function onPointerDown(e: PointerEvent) {
  try {
    ;(e.target as Element).setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  dragging.value = true
  fromX = e.clientX
  fromValue = value.value
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  value.value = quantise(fromValue + ((e.clientX - fromX) / PIXELS_PER_STEP) * props.step)
}

function onPointerUp() {
  dragging.value = false
}

function onReset() {
  if (props.resetTo != null) value.value = props.resetTo
}

// A write to the model only comes back on the next render, so several wheel events in
// one tick would all read the same stale value and collapse into a single step. The
// pending value carries the ones in between; an update from anywhere else clears it.
let pending: number | null = null
watch(value, (v) => {
  if (v !== pending) pending = null
})

function onWheel(e: WheelEvent) {
  e.preventDefault()
  pending = quantise((pending ?? value.value) + (e.deltaY > 0 ? -props.step : props.step))
  value.value = pending
}
</script>

<template>
  <div
    class="jog"
    :class="{ dragging }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick="onReset"
    @wheel="onWheel"
  >
    <span class="jog__label">{{ label }}</span>
    <small v-if="sub" class="jog__sub">{{ sub }}</small>
  </div>
</template>

<style scoped>
.jog {
  /* the ruler the value is dragged along */
  --tick: #4a4a4a;
  flex: 0 0 auto;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding-inline: 10px;
  border-radius: 6px;
  background-color: #191919;
  /* a ruler along the bottom edge, clear of the value. Running the ticks behind the text
     instead — as a full field of dots used to — leaves slivers showing either side of it,
     which read as a speckled border rather than as a scale */
  background-image: repeating-linear-gradient(90deg, var(--tick) 0 1px, transparent 1px 7px);
  background-size: 100% 4px;
  background-position: bottom;
  background-repeat: no-repeat;
  border: 1px solid #333;
  cursor: ew-resize;
  touch-action: none;
  user-select: none;
  overflow: hidden;
  white-space: nowrap;
}
.jog.dragging {
  --tick: #f59e0b;
}
/* nothing runs behind these any more, so they need no plate of their own */
.jog__label {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: #f2f2f2;
}
.jog__sub { color: #9a9a9a; }
</style>

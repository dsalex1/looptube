<script setup lang="ts">
import { PEAKS_PER_SECOND } from '@/helpers/audioPeaks'
import { useElementSize } from '@vueuse/core'
import { computed, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    peaks: Uint8Array
    duration: number
    start: number
    end: number
    markers: number[]
    loopA?: number | null
    loopB?: number | null
    /** the loop repeats; when it does not, the region is still shown but greyed out */
    loopActive?: boolean
    position: number
    /** the compact whole-track strip: no flags to grab, tap anywhere to seek */
    overview?: boolean
    /** the zoomed view: the wave is dragged under a fixed centre playhead */
    draggable?: boolean
    /** monitoring: the gain wave is a pure stretch of the source and needs no playing,
     * the other two are measured and fill in as the track plays */
    monitor?: boolean
    gainDb?: number
    outTrail?: Float32Array | null
    reductionTrail?: Float32Array | null
    reduction?: number
    /** where the limiter is holding the output, or null when it is passing through */
    ceilingDb?: number | null
    /** headroom above 0 dBFS to keep on screen, so what clips is visible rather than
     * flattened against the edge */
    headroomDb?: number
  }>(),
  { loopA: null, loopB: null, loopActive: true, ceilingDb: null, monitor: false, gainDb: 0, outTrail: null, reductionTrail: null, reduction: 0, headroomDb: 0 }
)

const emit = defineEmits<{
  (e: 'seek', seconds: number): void
  (e: 'moveMarker', index: number, seconds: number): void
  (e: 'moveLoop', which: 'a' | 'b', seconds: number): void
  (e: 'zoom', span: number): void
}>()

const COLORS = {
  background: '#050505',
  wave: '#dcdcdc',
  waveOverview: '#e8bd6d',
  loop: '#f59e0b',
  loopFill: 'rgba(245, 158, 11, 0.35)',
  loopOff: '#8b8b8b',
  loopOffFill: 'rgba(160, 160, 160, 0.22)',
  zeroLine: '#333',
  marker: '#4a90d9',
  playhead: '#e53935',
  handle: '#b3a086',
  grid: 'rgba(255, 255, 255, 0.13)',
  gridLabel: 'rgba(255, 255, 255, 0.4)',
  gainWave: '#ff6b3d',
  outTrail: '#3ddc84',
  ceiling: '#5ad07a',
  reductionCurve: '#f2f2f2',
}

// enough of a ladder that some step always lands 6-12 rules across the view
const TIME_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]

const REDUCTION_RANGE = 24 // dB of gain reduction that fills the top half of the view

// the wave is drawn on a linear amplitude scale, so a dB line sits at its amplitude ratio
const DB_LINES = [-3, -6, -12, -18, -24]
const amplitudeOf = (db: number) => 10 ** (db / 20)

const loopColor = computed(() => (props.loopActive ? COLORS.loop : COLORS.loopOff))

const FLAG_W = 26
const FLAG_H = 26
const HANDLE_W = 30
const HANDLE_H = 60

const wrapper = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const { width, height } = useElementSize(wrapper)

const span = computed(() => Math.max(props.end - props.start, 0.05))
const secondsPerPixel = computed(() => span.value / Math.max(width.value, 1))

// The wave is sampled on a grid fixed to the track, not to the canvas, so a column always
// covers the same slice of audio however far the view has scrolled — that keeps the shape
// frozen. The leftover sub-pixel remainder is applied as an offset when drawing, so the
// shape slides smoothly instead of stepping from pixel to pixel.
const gridIndex = computed(() => Math.floor(props.start / secondsPerPixel.value + 1e-9))
const subPixel = computed(() => props.start / secondsPerPixel.value - gridIndex.value)
const columnTime = (column: number) => (gridIndex.value + column) * secondsPerPixel.value

// Half the canvas normally means full scale. With headroom it means rather less, which
// is what leaves room above the 0 dB line for anything driven past it to be seen.
const fullScale = computed(() => height.value / 2 / amplitudeOf(props.headroomDb))
const yOf = (level: number) => Math.max(0, Math.min(height.value, height.value / 2 - level * fullScale.value))

const xOf = (seconds: number) => (seconds - props.start) / secondsPerPixel.value
const timeOf = (x: number) => props.start + x * secondsPerPixel.value
const clampTime = (t: number) => Math.max(0, Math.min(t, props.duration))

/** loudest value between two times, 0..1, over any per-bucket series */
function peakBetween(from: number, to: number, data: Uint8Array | Float32Array = props.peaks, scale = 1 / 255) {
  const first = Math.max(0, Math.floor(from * PEAKS_PER_SECOND))
  const last = Math.min(data.length - 1, Math.max(first, Math.ceil(to * PEAKS_PER_SECOND) - 1))
  let peak = 0
  for (let i = first; i <= last; i++) if (data[i] > peak) peak = data[i]
  return peak * scale
}

/**
 * Horizontal rules at fixed dBFS levels so a peak can be read as a number rather than
 * eyeballed. Drawn over the wave, faint enough not to fight it: the point is to see
 * where the wave crosses them.
 */
function drawDbGrid(ctx: CanvasRenderingContext2D) {
  const mid = height.value / 2
  ctx.lineWidth = 1
  ctx.font = '9px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  for (const db of [0, ...DB_LINES]) {
    const offset = amplitudeOf(db) * fullScale.value
    const top = Math.round(mid - offset) + 0.5
    const bottom = Math.round(mid + offset) - 0.5
    ctx.strokeStyle = COLORS.grid
    ctx.beginPath()
    ctx.moveTo(0, top)
    ctx.lineTo(width.value, top)
    ctx.moveTo(0, bottom)
    ctx.lineTo(width.value, bottom)
    ctx.stroke()
    ctx.fillStyle = COLORS.gridLabel
    // 0 dBFS sits on the canvas edge, so its label has to hang below the line
    ctx.fillText(`${db}`, 2, db === 0 ? top + 10 : top - 1)
  }
}

/** m:ss, with tenths only when the rules are close enough together to need them */
function timeLabel(seconds: number, step: number) {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  const whole = String(Math.floor(secs)).padStart(2, '0')
  return step < 1 ? `${mins}:${whole}.${Math.round((secs % 1) * 10)}` : `${mins}:${whole}`
}

/** vertical rules on round times, so a position can be read off rather than guessed at */
function drawTimeGrid(ctx: CanvasRenderingContext2D) {
  const step = TIME_STEPS.find((s) => span.value / s <= 12) ?? TIME_STEPS[TIME_STEPS.length - 1]
  ctx.strokeStyle = COLORS.grid
  ctx.fillStyle = COLORS.gridLabel
  ctx.lineWidth = 1
  ctx.font = '9px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  for (let at = Math.ceil(props.start / step) * step; at <= props.end; at += step) {
    if (at < 0 || at > props.duration) continue
    const x = Math.round(xOf(at)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height.value)
    ctx.stroke()
    ctx.fillText(timeLabel(at, step), x + 2, height.value - 2)
  }
}

function drawFlag(ctx: CanvasRenderingContext2D, x: number, label: string, inLoop: boolean) {
  const color = inLoop ? loopColor.value : COLORS.marker
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + 0.5, 0)
  ctx.lineTo(x + 0.5, height.value)
  ctx.stroke()

  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x, 4)
  ctx.lineTo(x + FLAG_W, 4)
  ctx.lineTo(x + FLAG_W, 4 + FLAG_H)
  ctx.lineTo(x + FLAG_W / 2, 4 + FLAG_H * 0.72)
  ctx.lineTo(x, 4 + FLAG_H)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = '#fff'
  ctx.font = 'bold 14px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + FLAG_W / 2, 4 + FLAG_H * 0.42)
}

function drawHandle(ctx: CanvasRenderingContext2D, x: number, label: 'A' | 'B') {
  const top = height.value * 0.55 - HANDLE_H / 2
  const left = label === 'A' ? x - HANDLE_W : x
  ctx.fillStyle = COLORS.handle
  ctx.strokeStyle = loopColor.value
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(left, top, HANDLE_W, HANDLE_H, 4)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#1a1a1a'
  ctx.font = 'bold 22px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, left + HANDLE_W / 2, top + HANDLE_H / 2)
}

/**
 * One filled silhouette rather than a row of separate bars: a solid shape can be shifted
 * by a fraction of a pixel and still read as the same shape sliding, whereas independent
 * bars each redistribute their own anti-aliasing and shimmer.
 */
function drawWave(ctx: CanvasRenderingContext2D, color: string, boost = 1) {
  const columns: { x: number; level: number }[] = []
  // a column either side of the canvas so the shape does not pop in at the edges
  for (let column = -1; column <= width.value + 1; column++) {
    const at = columnTime(column)
    if (at < 0 || at >= props.duration) continue // the view can extend past either end
    columns.push({ x: column - subPixel.value, level: peakBetween(at, columnTime(column + 1)) * boost })
  }
  if (!columns.length) return

  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(columns[0].x, yOf(columns[0].level))
  for (const c of columns) ctx.lineTo(c.x, yOf(c.level))
  for (let i = columns.length - 1; i >= 0; i--) ctx.lineTo(columns[i].x, yOf(-columns[i].level))
  ctx.closePath()
  ctx.fill()
}

/**
 * The measured level, mirrored around the centre like the wave but stroked rather than
 * filled, so the source wave stays readable underneath it. Buckets that have not been
 * played yet are zero and are left out, which is what makes the trail draw itself in as
 * the track plays.
 */
/** the level the limiter is holding the output to */
function drawCeiling(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = COLORS.ceiling
  ctx.lineWidth = 1
  const offset = amplitudeOf(props.ceilingDb ?? 0) * fullScale.value
  // the half pixel goes towards the middle on both sides, so the pair stays symmetric
  for (const y of [Math.round(height.value / 2 - offset) + 0.5, Math.round(height.value / 2 + offset) - 0.5]) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width.value, y)
    ctx.stroke()
  }
}

/**
 * Gain reduction hanging from the top edge, the way a limiter plugin draws it: the
 * deeper the curve dips, the harder the limiter is working at that point.
 */
function drawReduction(ctx: CanvasRenderingContext2D, data: Float32Array) {
  const points: { x: number; y: number }[] = []
  for (let column = -1; column <= width.value + 1; column++) {
    const at = columnTime(column)
    if (at < 0 || at >= props.duration) continue
    const db = peakBetween(at, columnTime(column + 1), data, 1)
    points.push({ x: column - subPixel.value, y: (Math.min(db, REDUCTION_RANGE) / REDUCTION_RANGE) * (height.value / 2) })
  }
  if (points.length < 2) return
  ctx.strokeStyle = COLORS.reductionCurve
  ctx.lineWidth = 1
  ctx.beginPath()
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  ctx.stroke()
}

function drawTrail(ctx: CanvasRenderingContext2D, data: Float32Array, color: string) {
  const mid = height.value / 2
  const runs: { x: number; amplitude: number }[][] = []
  let run: { x: number; amplitude: number }[] = []
  for (let column = -1; column <= width.value + 1; column++) {
    const at = columnTime(column)
    const level = at < 0 || at >= props.duration ? 0 : peakBetween(at, columnTime(column + 1), data, 1)
    if (level <= 0) {
      if (run.length) runs.push(run)
      run = []
      continue
    }
    run.push({ x: column - subPixel.value, amplitude: mid - yOf(level) })
  }
  if (run.length) runs.push(run)

  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.lineJoin = 'round'
  for (const points of runs) {
    for (const sign of [-1, 1]) {
      ctx.beginPath()
      points.forEach((p, i) => (i ? ctx.lineTo(p.x, mid + sign * p.amplitude) : ctx.moveTo(p.x, mid + sign * p.amplitude)))
      ctx.stroke()
    }
  }
}

/** what the two trails mean, plus what the limiter is doing about it right now */
function drawMonitorLegend(ctx: CanvasRenderingContext2D) {
  ctx.font = '9px sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  const entries: [string, string][] = [
    [`after gain (${props.gainDb > 0 ? '+' : ''}${props.gainDb.toFixed(1)} dB)`, COLORS.gainWave],
    ['output', COLORS.outTrail],
    [`${props.reduction <= -0.05 ? props.reduction.toFixed(1) : '0.0'} dB limiting`, COLORS.reductionCurve],
  ]
  entries.forEach(([label, color], i) => {
    ctx.fillStyle = color
    ctx.fillText(label, width.value - 4, 4 + i * 11)
  })
}

let backingWidth = 0
let backingHeight = 0

function draw() {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx || !width.value || !height.value) return

  const dpr = window.devicePixelRatio || 1
  // resizing clears and reallocates the backing store, so only do it when it really changed
  if (backingWidth !== width.value * dpr || backingHeight !== height.value * dpr) {
    backingWidth = canvas.value!.width = width.value * dpr
    backingHeight = canvas.value!.height = height.value * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, width.value, height.value)

  // zero line, under the wave so it shows through the quiet stretches
  const mid = Math.round(height.value / 2) + 0.5
  ctx.strokeStyle = COLORS.zeroLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, mid)
  ctx.lineTo(width.value, mid)
  ctx.stroke()

  // the boosted shape goes down first so the source reads as a core inside it; cutting
  // the gain instead makes it the smaller shape, so then it goes on top
  const boost = amplitudeOf(props.gainDb)
  if (props.monitor && boost > 1) drawWave(ctx, COLORS.gainWave, boost)
  drawWave(ctx, props.overview ? COLORS.waveOverview : COLORS.wave)
  if (props.monitor && boost < 1) drawWave(ctx, COLORS.gainWave, boost)
  if (!props.overview) {
    drawTimeGrid(ctx)
    drawDbGrid(ctx)
  }

  // A-B repeat region, drawn over the wave so the looped part reads as one block
  const { loopA, loopB } = props
  if (loopA != null && loopB != null) {
    const [left, right] = [xOf(loopA), xOf(loopB)]
    ctx.fillStyle = props.loopActive ? COLORS.loopFill : COLORS.loopOffFill
    ctx.fillRect(left, 0, right - left, height.value)
    ctx.save()
    ctx.beginPath()
    ctx.rect(left, 0, right - left, height.value)
    ctx.clip()
    drawWave(ctx, loopColor.value)
    ctx.restore()
  }

  if (props.monitor) {
    if (props.ceilingDb != null) drawCeiling(ctx)
    if (props.outTrail) drawTrail(ctx, props.outTrail, COLORS.outTrail)
    if (props.reductionTrail) drawReduction(ctx, props.reductionTrail)
    drawMonitorLegend(ctx)
  }

  props.markers.forEach((seconds, i) => {
    const x = xOf(seconds)
    if (x < -FLAG_W || x > width.value) return
    drawFlag(ctx, x, String(i + 1), isLoopBoundary(seconds))
  })

  if (loopA != null) drawHandle(ctx, xOf(loopA), 'A')
  if (loopB != null) drawHandle(ctx, xOf(loopB), 'B')

  const playX = xOf(props.position)
  ctx.strokeStyle = COLORS.playhead
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(playX, 0)
  ctx.lineTo(playX, height.value)
  ctx.stroke()
}

/** markers sitting on an A-B bound (or inside the loop) turn orange */
function isLoopBoundary(seconds: number) {
  const { loopA, loopB } = props
  if (loopA == null || loopB == null) return false
  return seconds >= loopA && seconds <= loopB
}

let pending = false
function scheduleDraw() {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    draw()
  })
}

// the immediate watch below runs before the canvas ref exists, so draw once it does
onMounted(draw)

watch(
  () => [props.peaks, props.start, props.end, props.markers, props.loopA, props.loopB, props.loopActive, props.position, props.monitor, props.ceilingDb, props.gainDb, props.outTrail, props.reductionTrail, props.headroomDb, width.value, height.value],
  scheduleDraw,
  { immediate: true, deep: true }
)

// --- pointer interaction ---
const TAP_SLOP = 4 // a press that moves less than this is a tap, not a drag

type Drag =
  | { kind: 'seek' }
  | { kind: 'marker'; index: number }
  | { kind: 'loop'; which: 'a' | 'b' }
  | { kind: 'pan'; fromX: number; fromPosition: number; moved: boolean }

let drag: Drag | null = null
const pointers = new Map<number, number>() // pointerId -> x
let pinchStart: { distance: number; span: number } | null = null

function localX(e: PointerEvent) {
  return e.clientX - (wrapper.value?.getBoundingClientRect().left ?? 0)
}

function hitTest(x: number, y: number): Drag {
  if (props.overview) return { kind: 'seek' }
  const handleTop = height.value * 0.55 - HANDLE_H / 2
  if (y >= handleTop && y <= handleTop + HANDLE_H) {
    if (props.loopA != null && Math.abs(x - (xOf(props.loopA) - HANDLE_W / 2)) < HANDLE_W / 2) return { kind: 'loop', which: 'a' }
    if (props.loopB != null && Math.abs(x - (xOf(props.loopB) + HANDLE_W / 2)) < HANDLE_W / 2) return { kind: 'loop', which: 'b' }
  }
  if (y <= 4 + FLAG_H) {
    const index = props.markers.findIndex((m) => x >= xOf(m) && x <= xOf(m) + FLAG_W)
    if (index >= 0) return { kind: 'marker', index }
  }
  // on the zoomed view an empty press drags the wave under the centre playhead
  return props.draggable ? { kind: 'pan', fromX: x, fromPosition: props.position, moved: false } : { kind: 'seek' }
}

function applyDrag(x: number) {
  if (!drag) return
  if (drag.kind === 'pan') {
    const travelled = x - drag.fromX
    if (Math.abs(travelled) > TAP_SLOP) drag.moved = true
    if (drag.moved) emit('seek', clampTime(drag.fromPosition - travelled * secondsPerPixel.value))
    return
  }
  const seconds = clampTime(timeOf(x))
  if (drag.kind === 'seek') emit('seek', seconds)
  if (drag.kind === 'marker') emit('moveMarker', drag.index, seconds)
  if (drag.kind === 'loop') emit('moveLoop', drag.which, seconds)
}

function onPointerDown(e: PointerEvent) {
  // capture is a nicety; a browser that refuses it must not lose the whole gesture
  try {
    ;(e.target as Element).setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  pointers.set(e.pointerId, e.clientX)
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    pinchStart = { distance: Math.abs(a - b), span: span.value }
    drag = null
    return
  }
  const rect = wrapper.value!.getBoundingClientRect()
  drag = hitTest(localX(e), e.clientY - rect.top)
  if (drag.kind !== 'pan') applyDrag(localX(e)) // a pan only acts once it actually moves
}

function onPointerMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, e.clientX)
  if (pinchStart && pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    emit('zoom', (pinchStart.span * pinchStart.distance) / Math.max(Math.abs(a - b), 1))
    return
  }
  if (drag) applyDrag(localX(e))
}

function onPointerUp(e: PointerEvent) {
  // a press that never moved is a tap: jump to the spot it landed on
  if (drag?.kind === 'pan' && !drag.moved) emit('seek', clampTime(timeOf(localX(e))))
  pointers.delete(e.pointerId)
  if (pointers.size < 2) pinchStart = null
  if (pointers.size === 0) drag = null
}

function onWheel(e: WheelEvent) {
  if (props.overview) return
  e.preventDefault()
  emit('zoom', span.value * (e.deltaY > 0 ? 1.2 : 1 / 1.2))
}
</script>

<template>
  <div
    ref="wrapper"
    class="waveform"
    :style="{ touchAction: overview || draggable ? 'none' : 'pan-y' }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
  >
    <canvas ref="canvas" style="display: block; width: 100%; height: 100%" />
  </div>
</template>

<style scoped>
.waveform {
  width: 100%;
  height: 100%;
  background: #050505;
  overflow: hidden;
  user-select: none;
}
</style>

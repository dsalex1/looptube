<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import WaveformCanvas from '@/components/WaveformCanvas.vue'
import type { PaneView } from '@/types'
import { computed } from 'vue'

const props = defineProps<{
  view: PaneView
  peaks: Uint8Array
  duration: number
  start: number
  end: number
  markers: number[]
  loopA: number | null
  loopB: number | null
  loopActive: boolean
  position: number
  /** the waveform is a flat bed because no real samples could be got for this video */
  synthetic: boolean
  status: string
  /** fetching audio: 0..1 when the length is known, -1 while it is not */
  progress: number | null
  progressLabel: string
}>()

defineEmits<{
  (e: 'seek', seconds: number): void
  (e: 'moveMarker', index: number, seconds: number): void
  (e: 'moveLoop', which: 'a' | 'b', seconds: number): void
  (e: 'zoom', span: number): void
}>()

const RADIUS = 20
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const determinate = computed(() => props.progress != null && props.progress >= 0)
const dash = computed(() => CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, props.progress ?? 0))))
const percent = computed(() => `${Math.round((props.progress ?? 0) * 100)}%`)
</script>

<template>
  <div class="stage">
    <!-- The player is never torn down by a view switch: unmounting the iframe would drop
         the stream and the position, so the video only ever gets hidden. -->
    <div class="video" v-show="view === 'video'">
      <div class="video__frame"><div id="yt-host" /></div>
    </div>

    <div class="wave" v-show="view === 'waveform'">
      <WaveformCanvas
        draggable
        :peaks="peaks"
        :duration="duration"
        :start="start"
        :end="end"
        :markers="markers"
        :loopA="loopA"
        :loopB="loopB"
        :loopActive="loopActive"
        :position="position"
        @seek="$emit('seek', $event)"
        @moveMarker="(i, s) => $emit('moveMarker', i, s)"
        @moveLoop="(w, s) => $emit('moveLoop', w, s)"
        @zoom="$emit('zoom', $event)"
      />
      <div v-if="synthetic && progress == null" class="hint">
        <Icon name="wave" stroke />
        <span>No audio samples for this video — markers and A-B still work.</span>
      </div>
    </div>

    <!-- fetching the audio can take a while off the home relay, so say so and show how far -->
    <div v-if="progress != null" class="busy">
      <svg class="ring" viewBox="0 0 48 48" :class="{ spin: !determinate }">
        <circle class="track" cx="24" cy="24" :r="RADIUS" />
        <circle
          class="head"
          cx="24"
          cy="24"
          :r="RADIUS"
          :stroke-dasharray="CIRCUMFERENCE"
          :stroke-dashoffset="determinate ? dash : CIRCUMFERENCE * 0.75"
        />
      </svg>
      <span class="busy__label">{{ progressLabel }}</span>
      <span v-if="determinate" class="busy__pct">{{ percent }}</span>
    </div>

    <div v-else-if="status" class="status">{{ status }}</div>
  </div>
</template>

<style scoped>
/* a floor, so a tall bar can squeeze the picture but never squeeze it away */
.stage { position: relative; flex: 1 1 0; min-height: 160px; background: #050505; }
.video, .wave { position: absolute; inset: 0; }
.video { display: flex; align-items: center; justify-content: center; container-type: size; }
/* whichever of the two the pane runs out of first decides the size, so the picture is
   always as large as it can be without ever being stretched out of shape */
.video__frame { aspect-ratio: 16 / 9; width: min(100cqw, calc(100cqh * 16 / 9)); }
.video__frame :deep(iframe) { width: 100%; height: 100%; border: 0; display: block; }
.hint {
  position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px; max-width: min(92%, 620px);
  padding: 7px 12px; border-radius: 8px; font-size: 12px; line-height: 1.35;
  background: rgba(20, 20, 20, 0.92); color: #b9b9b9; border: 1px solid #2a2a2a;
}
.hint svg { flex: none; color: #f59e0b; }
.status {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  padding: 6px 14px; border-radius: 999px; font-size: 13px;
  background: rgba(20, 20, 20, 0.92); color: #e6e6e6; border: 1px solid #2a2a2a;
}

.busy {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px 8px 10px;
  border-radius: 999px;
  background: rgba(16, 16, 16, 0.94);
  border: 1px solid #2e2e2e;
  color: #e6e6e6;
  font-size: 13px;
}
.ring { width: 26px; height: 26px; flex: none; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 5; }
.ring .track { stroke: #2c2c2c; }
.ring .head { stroke: #f59e0b; stroke-linecap: round; transition: stroke-dashoffset 0.15s linear; }
.ring.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(270deg); } }
.busy__pct { font-variant-numeric: tabular-nums; color: #9a9a9a; }
</style>

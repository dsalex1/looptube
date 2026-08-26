<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import WaveformCanvas from '@/components/WaveformCanvas.vue'
import type { PaneView } from '@/types'

defineProps<{
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
}>()

defineEmits<{
  (e: 'seek', seconds: number): void
  (e: 'moveMarker', index: number, seconds: number): void
  (e: 'moveLoop', which: 'a' | 'b', seconds: number): void
  (e: 'zoom', span: number): void
}>()
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
        :headroomDb="2"
        @seek="$emit('seek', $event)"
        @moveMarker="(i, s) => $emit('moveMarker', i, s)"
        @moveLoop="(w, s) => $emit('moveLoop', w, s)"
        @zoom="$emit('zoom', $event)"
      />
      <div v-if="synthetic" class="hint">
        <Icon name="wave" stroke />
        <span>No audio samples for this video — markers and A-B still work. Add an extractor in settings for a real waveform.</span>
      </div>
    </div>

    <div v-if="status" class="status">{{ status }}</div>
  </div>
</template>

<style scoped>
.stage { position: relative; flex: 1 1 0; min-height: 0; background: #050505; }
.video, .wave { position: absolute; inset: 0; }
.video { display: flex; align-items: center; justify-content: center; }
.video__frame { width: 100%; max-height: 100%; aspect-ratio: 16 / 9; }
.video__frame :deep(iframe) { width: 100%; height: 100%; border: 0; display: block; }
.hint {
  position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px; max-width: min(92%, 620px);
  padding: 7px 12px; border-radius: 8px; font-size: 12px; line-height: 1.35;
  background: rgba(20, 20, 20, 0.92); color: #b9b9b9; border: 1px solid #2a2a2a;
}
.hint svg { flex: none; color: #e8bd6d; }
.status {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  padding: 6px 14px; border-radius: 999px; font-size: 13px;
  background: rgba(20, 20, 20, 0.92); color: #e6e6e6; border: 1px solid #2a2a2a;
}
</style>

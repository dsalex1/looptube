import { loadIframeApi } from '@/helpers/youtube'
import type { Transport } from '@/types'
import { onUnmounted, ref, watch } from 'vue'

/** YouTube only accepts these rates; anything else is silently ignored. */
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

const nearestRate = (v: number) => RATES.reduce((best, r) => (Math.abs(r - v) < Math.abs(best - v) ? r : best), 1)

/**
 * The YouTube player wearing the same face as the Web Audio engine, so one set of
 * controls drives either. The clock is polled rather than pushed: the IFrame API only
 * reports time on demand, so a frame loop reads it and the A-B repeat rides along.
 */
export function useYouTubePlayer(host: () => HTMLElement | undefined): Transport & {
  mount(videoId: string): Promise<void>
} {
  const currentTime = ref(0)
  const duration = ref(0)
  const playing = ref(false)
  const loading = ref(false)
  const error = ref('')
  const tempo = ref(1)
  const pitch = ref(0) // never leaves 0: YouTube has no pitch control
  const gainDb = ref(0)
  const loopA = ref<number | null>(null)
  const loopB = ref<number | null>(null)
  const loopEnabled = ref(true)

  let player: YT.Player | null = null
  let frame: number | null = null
  let mountToken = 0

  const looping = () => loopEnabled.value && loopA.value != null && loopB.value != null

  function tick() {
    if (!player) return
    const at = player.getCurrentTime?.() ?? 0
    // A-B repeat: jump back as soon as the playhead runs past B
    if (looping() && at >= loopB.value!) seek(loopA.value!)
    else currentTime.value = at
    if (!duration.value) duration.value = player.getDuration?.() ?? 0
    frame = requestAnimationFrame(tick)
  }

  function startTicking() {
    if (frame == null) frame = requestAnimationFrame(tick)
  }

  function stopTicking() {
    if (frame != null) cancelAnimationFrame(frame)
    frame = null
  }

  async function mount(videoId: string) {
    const token = ++mountToken
    const api = await loadIframeApi()
    const element = host()
    if (!element || token !== mountToken) return

    loading.value = true
    error.value = ''
    duration.value = 0
    currentTime.value = 0

    // loadVideoById keeps the existing iframe, which matters: tearing it down and
    // building a new one costs a fresh handshake and loses the buffered stream
    if (player) {
      player.loadVideoById(videoId)
      player.pauseVideo()
      return
    }

    player = new api.Player(element, {
      videoId,
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1, controls: 0, disablekb: 1 },
      events: {
        onReady: (e) => {
          loading.value = false
          duration.value = e.target.getDuration()
          e.target.setPlaybackRate(nearestRate(tempo.value))
          e.target.setVolume(volumeOf(gainDb.value))
        },
        onStateChange: (e) => {
          playing.value = e.data === api.PlayerState.PLAYING
          if (playing.value) startTicking()
          else stopTicking()
          if (e.data === api.PlayerState.ENDED) currentTime.value = duration.value
          if (!duration.value) duration.value = e.target.getDuration()
        },
        onError: () => {
          loading.value = false
          error.value = 'YouTube will not play this video here (it may be private, deleted or embed-blocked)'
        },
      },
    })
  }

  /** dB onto YouTube's 0-100 scale; it only attenuates, so a boost pins at full. */
  const volumeOf = (db: number) => Math.max(0, Math.min(100, Math.round(100 * 10 ** (Math.min(db, 0) / 20))))

  function play() {
    if (looping() && (currentTime.value < loopA.value! || currentTime.value >= loopB.value!)) seek(loopA.value!)
    player?.playVideo()
  }

  const pause = () => player?.pauseVideo()
  const toggle = () => (playing.value ? pause() : play())

  function seek(seconds: number) {
    if (!Number.isFinite(seconds)) return
    const at = Math.max(0, Math.min(seconds, duration.value || seconds))
    currentTime.value = at
    player?.seekTo(at, true)
  }

  const skip = (seconds: number) => seek(currentTime.value + seconds)

  watch(tempo, (v) => player?.setPlaybackRate(nearestRate(v)))
  watch(gainDb, (v) => player?.setVolume(volumeOf(v)))

  onUnmounted(() => {
    stopTicking()
    player?.destroy()
    player = null
  })

  return {
    currentTime, duration, playing, loading, error, tempo, pitch, gainDb,
    loopA, loopB, loopEnabled, play, pause, toggle, seek, skip, mount,
    can: { pitch: false, boost: false, tempoSteps: RATES },
  }
}

import { clampRate, YT_RATE_MAX, YT_RATE_MIN } from '@/helpers/videoSync'
import { loadIframeApi } from '@/helpers/youtube'
import type { Transport } from '@/types'
import { onUnmounted, ref, watch } from 'vue'

/**
 * The YouTube player wearing the same face as the Web Audio engine, so one set of
 * controls drives either. The clock is polled rather than pushed: the IFrame API only
 * reports time on demand, so a frame loop reads it and the A-B repeat rides along.
 */
export function useYouTubePlayer(host: () => HTMLElement | undefined): Transport & {
  mount(videoId: string): Promise<void>
  setRate(rate: number): void
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

  /**
   * Force subtitles off.
   *
   * The embed inherits the account's "always show captions" preference, and `controls: 0`
   * takes away the CC button that would turn them back off — so they come on by themselves
   * and cannot be dismissed. `cc_load_policy: 0` only means "do not force them on", which
   * does not undo the preference; unloading the module does. The module is named `captions`
   * on the HTML5 player and `cc` on the old one, and unloading one that was never loaded
   * throws, so both are tried and neither is trusted. It is re-applied on every start
   * because the module is loaded lazily with playback and again for each new video.
   */
  function hideCaptions(target: YT.Player) {
    for (const module of ['captions', 'cc']) {
      try {
        target.unloadModule(module)
      } catch {
        /* not loaded on this player: nothing to unload */
      }
    }
  }

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
      hideCaptions(player)
      return
    }

    player = new api.Player(element, {
      videoId,
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1, controls: 0, disablekb: 1, cc_load_policy: 0 },
      events: {
        onReady: (e) => {
          loading.value = false
          duration.value = e.target.getDuration()
          e.target.setPlaybackRate(clampRate(tempo.value))
          e.target.setVolume(volumeOf(gainDb.value))
          hideCaptions(e.target)
        },
        onStateChange: (e) => {
          playing.value = e.data === api.PlayerState.PLAYING
          if (playing.value) {
            hideCaptions(e.target)
            startTicking()
          } else stopTicking()
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

  /**
   * Run the picture a shade off its tempo. This is how it is kept with the engine when the
   * engine is the one making sound: bending the rate is invisible, where seeking flickers
   * the player's own controls every time. The next `tempo` change overrides it, and the
   * follower simply nudges again.
   */
  const setRate = (rate: number) => player?.setPlaybackRate(clampRate(rate))

  watch(tempo, (v) => player?.setPlaybackRate(clampRate(v)))
  watch(gainDb, (v) => player?.setVolume(volumeOf(v)))

  onUnmounted(() => {
    stopTicking()
    player?.destroy()
    player = null
  })

  return {
    currentTime, duration, playing, loading, error, tempo, pitch, gainDb,
    loopA, loopB, loopEnabled, play, pause, toggle, seek, skip, mount, setRate,
    can: { pitch: false, boost: false, tempoMin: YT_RATE_MIN, tempoMax: YT_RATE_MAX },
  }
}

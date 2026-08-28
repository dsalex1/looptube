/**
 * Keeping the muted video with the audio.
 *
 * When real audio is playing the Web Audio engine is the clock and the YouTube iframe is
 * a picture that has to keep up with it. It can, further than it lets on: the player
 * advertises a ladder of playback rates but in fact accepts any rate between the ends of
 * it — measured, not assumed, by `__test-yt-rate.html`. Rounding the tempo to a rung, as
 * this used to, left the picture running at a different speed from the sound and drifting
 * a little further from it every second.
 *
 * Past the top of the range the picture simply cannot keep up, and all that is left is to
 * pull it back now and then. The logic lives here rather than in App.vue so it can be
 * measured without a browser — see `__tests__/videoSync.spec.ts`.
 */

/** the range the player really honours, whatever `getAvailablePlaybackRates` claims */
export const YT_RATE_MIN = 0.25
export const YT_RATE_MAX = 2

/** how far the picture may wander from the sound before it is pulled back, in seconds */
export const DRIFT = 0.15

/** a seek costs a visible stutter, so they are not allowed to come thick and fast */
export const RESYNC_COOLDOWN = 0.5

export const clampRate = (v: number) => Math.max(YT_RATE_MIN, Math.min(YT_RATE_MAX, v))

/** video-seconds gained or lost per real second once the rate has hit the player's ceiling */
export const videoDriftPerSecond = (tempo: number) => Math.abs(clampRate(tempo) - tempo)

export interface FollowResult {
  /** the worst gap between what is seen and what is heard, in seconds */
  maxError: number
  /** how many times the picture had to be yanked back into place; each one is a stutter */
  resyncs: number
}

/**
 * Play the follow loop forward on paper: the video runs at whatever rate the player would
 * accept, the engine runs at the tempo it was asked for, and the gap is checked every
 * frame. A run needing many resyncs looks broken however small `maxError` stays, which is
 * why both are reported.
 */
export function simulateFollow(
  tempo: number,
  { seconds = 60, fps = 60, drift = DRIFT, cooldown = RESYNC_COOLDOWN, rate = clampRate(tempo) } = {}
): FollowResult {
  let audio = 0
  let video = 0
  let maxError = 0
  let resyncs = 0
  let sinceResync = cooldown
  for (let frame = 0; frame < seconds * fps; frame++) {
    audio += tempo / fps
    video += rate / fps
    sinceResync += 1 / fps
    maxError = Math.max(maxError, Math.abs(video - audio))
    if (Math.abs(video - audio) > drift && sinceResync >= cooldown) {
      video = audio
      sinceResync = 0
      resyncs++
    }
  }
  return { maxError, resyncs }
}

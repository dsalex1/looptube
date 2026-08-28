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

/**
 * A gap this wide is a jump — a loop wrapping, or a scrub — not drift, and nothing but a
 * seek will close it. Anything smaller is bent away by trimming the rate instead: seeking
 * the iframe flickers its play button every time, which is worse to sit in front of than
 * a picture a tenth of a second out.
 */
export const JUMP = 1

/** how hard the picture is pulled back, per second of error */
const SLEW = 0.6

/** the most the rate may be bent; past this the correction itself becomes visible */
const SLEW_LIMIT = 0.08

/** how far apart two rates must be before it is worth telling the player about it */
export const RATE_EPSILON = 0.004

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
 * The rate to run the picture at to close a gap of `error` seconds, where a positive
 * error means the sound is ahead and the picture has to hurry.
 */
export const followRate = (tempo: number, error: number) =>
  clampRate(tempo * (1 + Math.max(-SLEW_LIMIT, Math.min(SLEW_LIMIT, error * SLEW))))

/**
 * Play the follow loop forward on paper. A run needing any resync at all is a run that
 * flickers the player's controls, which is the thing being avoided, so both the worst gap
 * and the resync count are reported.
 */
export function simulateFollow(tempo: number, { seconds = 60, fps = 60, offset = 0 } = {}): FollowResult {
  let audio = 0
  let video = -offset // the player's own clock need not agree with ours to begin with
  let maxError = 0
  let resyncs = 0
  for (let frame = 0; frame < seconds * fps; frame++) {
    const error = audio - video
    maxError = Math.max(maxError, Math.abs(error))
    if (Math.abs(error) > JUMP) {
      video = audio
      resyncs++
      continue
    }
    audio += tempo / fps
    video += followRate(tempo, error) / fps
  }
  return { maxError, resyncs }
}

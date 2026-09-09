/**
 * The clicks counted off before the track comes in.
 *
 * Every beat is scheduled up front on an audio clock, so the count itself is exact; what
 * is inexact is the hand-off, since the thing being counted in may be the YouTube iframe,
 * which has no clock to be scheduled against. So the count resolves `lead` seconds early
 * — whatever the player takes to get sound out — and the caller presses play then.
 */

let ctx: AudioContext | null = null

function click(at: number, accent: boolean) {
  const osc = ctx!.createOscillator()
  const env = ctx!.createGain()
  osc.frequency.value = accent ? 1500 : 1000
  env.gain.setValueAtTime(0.6, at)
  env.gain.exponentialRampToValueAtTime(0.001, at + 0.05)
  osc.connect(env)
  env.connect(ctx!.destination)
  osc.start(at)
  osc.stop(at + 0.05)
  return osc
}

/** Count the beats off. `done` resolves true on the downbeat, or false once cancelled. */
export function countOff(beats: number, bpm: number, lead = 0) {
  ctx ??= new AudioContext()
  void ctx.resume()
  const interval = 60 / Math.max(bpm, 1)
  const first = ctx.currentTime + 0.1 // room to schedule before the first beat is due
  const oscillators = Array.from({ length: beats }, (_, beat) => click(first + beat * interval, beat === 0))
  const downbeat = first + beats * interval

  let cancel = () => {}
  const done = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), Math.max(0, downbeat - lead - ctx!.currentTime) * 1000)
    cancel = () => {
      clearTimeout(timer)
      for (const osc of oscillators) {
        try {
          osc.stop()
        } catch {
          /* already finished */
        }
        osc.disconnect()
      }
      resolve(false)
    }
  })
  return { done, cancel }
}

import { describe, expect, it } from 'vitest'
import { simulateFollow, videoDriftPerSecond, YT_RATE_MAX } from '@/helpers/videoSync'

/** every tempo the jog wheel can reach with real audio loaded */
const sweep = () => {
  const out: number[] = []
  for (let t = 0.25; t <= 4.0001; t += 0.05) out.push(Math.round(t * 100) / 100)
  return out
}

const reachable = () => sweep().filter((t) => t <= YT_RATE_MAX)

describe('the muted video following the engine', () => {
  it('runs at the tempo it was asked for, wherever the player can', () => {
    expect(reachable().filter((tempo) => videoDriftPerSecond(tempo) > 1e-9)).toEqual([])
  })

  it('never needs pulling back into place at a tempo the player can hold', () => {
    const jerky = reachable()
      .map((tempo) => ({ tempo, ...simulateFollow(tempo, { seconds: 300 }) }))
      .filter((r) => r.resyncs > 0)
    expect(jerky).toEqual([])
  })

  it('past the player`s ceiling, corrects on a cadence rather than every frame', () => {
    // the picture cannot keep up above 2x and there is no fixing that; what it must not
    // do is stutter continuously trying
    const { resyncs } = simulateFollow(3, { seconds: 60 })
    expect(resyncs).toBeLessThanOrEqual(60 / 0.5)
    expect(resyncs).toBeGreaterThan(0)
  })
})

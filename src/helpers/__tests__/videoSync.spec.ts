import { describe, expect, it } from 'vitest'
import { clampRate, followRate, simulateFollow, videoDriftPerSecond, YT_RATE_MAX } from '@/helpers/videoSync'

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

  it('closes an offset by trimming the rate, never by seeking', () => {
    // the two clocks do not start out agreeing: the player reports its own idea of where
    // it is, and that idea is a little behind what we are hearing
    const rough = reachable().map((tempo) => ({ tempo, ...simulateFollow(tempo, { offset: 0.4 }) }))
    expect(rough.filter((r) => r.resyncs > 0)).toEqual([])
    expect(rough.filter((r) => r.maxError > 0.45)).toEqual([])
  })

  it('settles rather than hunting', () => {
    expect(simulateFollow(1.15, { offset: 0.4, seconds: 30 }).maxError).toBeLessThan(0.45)
    expect(followRate(1.15, 0)).toBeCloseTo(1.15, 6)
  })

  it('still seeks for a jump, which no amount of trimming would close', () => {
    // a loop wrapping back to A is not drift
    expect(simulateFollow(1, { offset: 30, seconds: 10 }).resyncs).toBe(1)
  })

  it('never asks the player for a rate it cannot hold', () => {
    for (const tempo of sweep())
      for (const error of [-5, -0.3, 0, 0.3, 5]) {
        const rate = followRate(tempo, error)
        expect(rate).toBe(clampRate(rate))
      }
  })
})

import { autoNumbers } from '@/helpers/autoNumber'
import { computePeaks, PEAK_CEILING } from '@/helpers/audioPeaks'
import { emptyState, fromHash, toHash } from '@/helpers/persist'
import { videoId } from '@/helpers/youtube'
import { describe, expect, it } from 'vitest'

describe('videoId', () => {
  const ID = 'dQw4w9WgXcQ'

  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&list=PL123&index=2`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `youtube.com/watch?v=${ID}`,
    ID,
  ])('reads %s', (input) => expect(videoId(input)).toBe(ID))

  it.each(['', 'not a link', 'https://vimeo.com/12345', 'https://youtube.com/watch?v=tooshort'])(
    'rejects %s',
    (input) => expect(videoId(input)).toBeNull()
  )
})

describe('hash round trip', () => {
  it('carries the loop, markers and tempo', () => {
    const state = { ...emptyState(), loopA: 12.345, loopB: 40, markers: [{ at: 1.5 }, { at: 9 }], tempo: 0.75, pitch: -2 }
    const parsed = fromHash(toHash('dQw4w9WgXcQ', state))

    expect(parsed?.id).toBe('dQw4w9WgXcQ')
    expect(parsed?.state.loopA).toBeCloseTo(12.35, 2)
    expect(parsed?.state.loopB).toBe(40)
    expect(parsed?.state.markers).toEqual([{ at: 1.5 }, { at: 9 }])
    expect(parsed?.state.tempo).toBe(0.75)
    expect(parsed?.state.pitch).toBe(-2)
  })

  it('carries what a marker and a loop are called, and which markers are skips', () => {
    const state = {
      ...emptyState(),
      markers: [{ at: 4, name: 'Verse, 2nd' }, { at: 8, skip: true }],
      loops: [{ a: 1, b: 2, name: 'Solo ~ fast' }],
    }
    const parsed = fromHash(toHash('dQw4w9WgXcQ', state))

    expect(parsed?.state.markers).toEqual(state.markers)
    expect(parsed?.state.loops).toEqual(state.loops)
  })

  it('leaves defaults out of the link', () => {
    expect(toHash('dQw4w9WgXcQ', emptyState())).toBe('#v=dQw4w9WgXcQ')
  })

  it('ignores a hash with no video', () => expect(fromHash('#a=1')).toBeNull())
})

describe('computePeaks', () => {
  const peaksOf = (fill: number, first: number) => {
    const sampleRate = 100
    const samples = new Float32Array(sampleRate)
    samples.fill(fill)
    samples[0] = first // the loudest sample in its bucket is what survives

    return computePeaks(
      { numberOfChannels: 1, length: samples.length, sampleRate, getChannelData: () => samples },
      10 // ten buckets per second, so ten samples each
    )
  }

  it('reduces samples to one byte per bucket, scaled to the ceiling above 0 dBFS', () => {
    const peaks = peaksOf(0.5, 1)
    expect(peaks.length).toBe(10)
    expect(peaks[0]).toBe(Math.round((1 / PEAK_CEILING) * 255)) // 0 dBFS, short of the top
    expect(peaks[1]).toBe(Math.round((0.5 / PEAK_CEILING) * 255))
  })

  it('keeps peaks driven past 0 dBFS apart, up to the ceiling', () => {
    expect(peaksOf(0, 1.1)[0]).toBeGreaterThan(peaksOf(0, 1)[0])
    expect(peaksOf(0, PEAK_CEILING * 2)[0]).toBe(255)
  })
})

describe('autoNumbers', () => {
  it('numbers the unnamed ones through the track, whatever order they were made in', () => {
    expect(autoNumbers([{ at: 30 }, { at: 10 }, { at: 20 }])).toEqual([3, 1, 2])
  })

  it('skips the named ones rather than leaving a gap', () => {
    expect(autoNumbers([{ at: 10 }, { at: 20, name: 'Chorus' }, { at: 30 }])).toEqual([1, undefined, 2])
  })
})

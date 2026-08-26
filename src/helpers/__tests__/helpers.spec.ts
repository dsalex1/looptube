import { computePeaks } from '@/helpers/audioPeaks'
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
    const state = { ...emptyState(), loopA: 12.345, loopB: 40, markers: [1.5, 9], tempo: 0.75, pitch: -2 }
    const parsed = fromHash(toHash('dQw4w9WgXcQ', state))

    expect(parsed?.id).toBe('dQw4w9WgXcQ')
    expect(parsed?.state.loopA).toBeCloseTo(12.35, 2)
    expect(parsed?.state.loopB).toBe(40)
    expect(parsed?.state.markers).toEqual([1.5, 9])
    expect(parsed?.state.tempo).toBe(0.75)
    expect(parsed?.state.pitch).toBe(-2)
  })

  it('leaves defaults out of the link', () => {
    expect(toHash('dQw4w9WgXcQ', emptyState())).toBe('#v=dQw4w9WgXcQ')
  })

  it('ignores a hash with no video', () => expect(fromHash('#a=1')).toBeNull())
})

describe('computePeaks', () => {
  it('reduces samples to one byte per bucket at full scale', () => {
    const sampleRate = 100
    const samples = new Float32Array(sampleRate)
    samples.fill(0.5)
    samples[0] = 1 // the loudest sample in its bucket is what survives

    const peaks = computePeaks(
      { numberOfChannels: 1, length: samples.length, sampleRate, getChannelData: () => samples },
      10 // ten buckets per second, so ten samples each
    )

    expect(peaks.length).toBe(10)
    expect(peaks[0]).toBe(255)
    expect(peaks[1]).toBe(128)
  })
})

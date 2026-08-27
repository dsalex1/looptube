/**
 * Draw the PWA icons. Kept as a script rather than checked-in binaries nobody can edit:
 * the icons are a handful of rounded bars, so generating them beats maintaining art.
 *
 * Rendered at 4x and box-downsampled, which is all the anti-aliasing a shape this simple
 * needs, and avoids pulling in a raster library for four files.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const BG = [0x0d, 0x0d, 0x0d]
const FG = [0xe8, 0xbd, 0x6d]
const SS = 4 // supersample factor

// the waveform glyph: relative heights, quiet at the edges and loud in the middle
const BARS = [0.3, 0.52, 0.78, 0.44, 1, 0.66, 0.36, 0.6, 0.26]

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  // one filter byte per scanline, filter 0 (none)
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3
      raw.set(rgb.subarray(i, i + 3), row + 1 + x * 3)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** inset is the share of the canvas left empty around the glyph — maskable icons need more */
function draw(size, inset, rounded) {
  const n = size * SS
  const big = new Uint8Array(n * n * 3)
  const radius = rounded ? n * 0.22 : 0

  const inCanvas = (x, y) => {
    if (!rounded) return true
    // rounded square: only the four corner discs are outside
    const cx = Math.min(Math.max(x, radius), n - radius)
    const cy = Math.min(Math.max(y, radius), n - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
  }

  const pad = n * inset
  const span = n - pad * 2
  const barW = span / (BARS.length * 2 - 1)
  const barR = barW / 2

  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let colour = inCanvas(x, y) ? BG : null
      if (colour) {
        for (let b = 0; b < BARS.length; b++) {
          const left = pad + b * barW * 2
          const h = span * BARS[b]
          const top = (n - h) / 2
          // a bar is a rounded capsule, so clamp to its straight section then measure
          const px = Math.min(Math.max(x, left + barR), left + barW - barR)
          const py = Math.min(Math.max(y, top + barR), top + h - barR)
          if ((x - px) ** 2 + (y - py) ** 2 <= barR ** 2) {
            colour = FG
            break
          }
        }
      }
      const i = (y * n + x) * 3
      if (colour) big.set(colour, i)
    }

  // box-downsample the supersampled buffer
  const out = new Uint8Array(size * size * 3)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0]
      for (let dy = 0; dy < SS; dy++)
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * n + x * SS + dx) * 3
          acc[0] += big[i]
          acc[1] += big[i + 1]
          acc[2] += big[i + 2]
        }
      const i = (y * size + x) * 3
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(acc[c] / (SS * SS))
    }
  return out
}

mkdirSync(OUT, { recursive: true })
const files = [
  ['icon-192.png', 192, 0.2, true],
  ['icon-512.png', 512, 0.2, true],
  // maskable art is cropped to a circle by the launcher, so it is full-bleed and inset more
  ['maskable-512.png', 512, 0.3, false],
  ['apple-touch-icon.png', 180, 0.2, false],
]
for (const [name, size, inset, rounded] of files) {
  writeFileSync(join(OUT, name), png(size, draw(size, inset, rounded)))
  console.log('wrote', name, size + 'px')
}

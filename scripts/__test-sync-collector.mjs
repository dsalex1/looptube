/**
 * Somewhere for the sync lab to put its numbers, so a run can be started from the command
 * line and read from a file instead of clicked through and screenshotted.
 *
 *   node scripts/__test-sync-collector.mjs
 *   chrome --user-data-dir=<fresh temp dir> --autoplay-policy=no-user-gesture-required \
 *     "http://localhost:5173/looptube/__test-sync-lab.html?auto=1&post=http://localhost:8899/"
 *
 * The autoplay flag matters: without a user gesture the AudioContext never leaves
 * suspended and the page waits forever for a `resume()` that cannot come.
 */
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const PORT = 8899

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method !== 'POST') return res.end('ok')

  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const file = `sync-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    writeFileSync(file, body)
    const report = JSON.parse(body)
    console.log(`\n${file} · output latency ${report.outputLatencyMs} ms`)
    console.table(report.audio)
    console.table(report.video)
    res.end('ok')
  })
}).listen(PORT, () => console.log(`waiting for a run on http://localhost:${PORT}/`))

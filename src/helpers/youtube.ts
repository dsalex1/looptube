/** Pull the 11-character video id out of anything a user is likely to paste. */
export function videoId(input: string): string | null {
  const s = input.trim()
  if (/^[\w-]{11}$/.test(s)) return s
  let url: URL
  try {
    url = new URL(s.startsWith('http') ? s : `https://${s}`)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  const id =
    host === 'youtu.be'
      ? url.pathname.slice(1)
      : url.searchParams.get('v') ?? url.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/)?.[1]
  return id && /^[\w-]{11}$/.test(id) ? id : null
}

/** The YouTube IFrame API is a singleton script; every player waits on the same load. */
let apiReady: Promise<typeof YT> | null = null

export function loadIframeApi(): Promise<typeof YT> {
  return (apiReady ??= new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT)
    // the API calls this global exactly once, so chain rather than overwrite
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      resolve(window.YT)
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(script)
  }))
}

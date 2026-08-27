export interface Recent {
  id: string
  title: string
  /** seconds, for the card; 0 until the track has been decoded once */
  duration: number
  at: number
}

const KEY = 'looptube:recents'
const LIMIT = 24

export function recents(): Recent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.id === 'string') : []
  } catch {
    return []
  }
}

const write = (list: Recent[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT)))
  } catch {
    /* private mode, or full: the app still works, it just forgets */
  }
}

/**
 * Move a video to the front, keeping whatever we already knew about it. A later visit
 * often knows the title when the first one did not, so details are merged rather than
 * replaced — an entry never loses its title by being opened again from a bare link.
 */
export function remember(entry: { id: string; title?: string; duration?: number }) {
  const list = recents()
  const existing = list.find((r) => r.id === entry.id)
  const merged: Recent = {
    id: entry.id,
    title: entry.title || existing?.title || '',
    duration: entry.duration || existing?.duration || 0,
    at: Date.now(),
  }
  write([merged, ...list.filter((r) => r.id !== entry.id)])
}

export function forget(id: string) {
  write(recents().filter((r) => r.id !== id))
}

export const thumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`

export function ago(at: number) {
  const seconds = Math.max(0, (Date.now() - at) / 1000)
  const [value, unit] =
    seconds < 60
      ? [seconds, 'second']
      : seconds < 3600
        ? [seconds / 60, 'minute']
        : seconds < 86400
          ? [seconds / 3600, 'hour']
          : [seconds / 86400, 'day']
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.round(value), unit as Intl.RelativeTimeFormatUnit)
}

export function clock(seconds: number) {
  if (!seconds) return ''
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

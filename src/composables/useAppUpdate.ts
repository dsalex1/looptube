import { registerSW } from 'virtual:pwa-register'
import { ref } from 'vue'

/**
 * Whether a newer build is waiting, and how to take it.
 *
 * A service worker fetches the new build in the background but will not take over while
 * the old one is still driving, so an installed app that is never fully closed can sit on
 * a stale version indefinitely and say nothing about it. Here the new worker parks,
 * `updateReady` flips, and the reload onto it is the user's to ask for.
 *
 * Registration happens once, when this module is first imported, so every caller sees the
 * same flag.
 */

/** A tab that stays open only learns about a new build if it goes and asks. */
const CHECK_INTERVAL = 60 * 60_000

export const updateReady = ref(false)

const applyUpdate = registerSW({
  immediate: true,
  onNeedRefresh: () => (updateReady.value = true),
  onRegisteredSW(_url, registration) {
    if (!registration) return
    const check = () => void registration.update().catch(() => {})
    setInterval(check, CHECK_INTERVAL)
    // an app on a phone is brought back to the front far more often than it is reloaded,
    // so that is the moment worth spending a check on
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check())
  },
})

/** Reload onto the waiting build. */
export const installUpdate = () => applyUpdate(true)

const STORAGE_KEY = "kool.attribution.v1"
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
const CLICK_ID = /^[a-zA-Z0-9_-]{1,128}$/
const memoryOnly = {}
const unsaved = new WeakMap()

function valid(saved, now) {
  return (
    saved &&
    typeof saved.clickId === "string" &&
    CLICK_ID.test(saved.clickId) &&
    Number.isFinite(saved.savedAt) &&
    saved.savedAt <= now &&
    now - saved.savedAt < MAX_AGE_MS
  )
}

function context(options) {
  let storage = options.storage
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage
    } catch {
      storage = null
    }
  }
  return { storage, now: options.now ?? Date.now() }
}

/** Read a click ID saved by captureAttribution; storage failures are harmless. */
export function getAttribution(options = {}) {
  const { storage, now } = context(options)
  const key = storage ?? memoryOnly
  const fallback = unsaved.get(key)
  if (!valid(fallback, now)) unsaved.delete(key)
  let saved
  try {
    saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null")
    if (!valid(saved, now)) storage?.removeItem(STORAGE_KEY)
  } catch {
    // A current-page click still works when storage is blocked or read-only.
  }
  if (valid(fallback, now) && (!valid(saved, now) || fallback.savedAt > saved.savedAt))
    return fallback.clickId
  if (valid(saved, now)) {
    unsaved.delete(key)
    return saved.clickId
  }
  return null
}

/** Save the latest kool_cid, without storing the URL or any other query field. */
export function captureAttribution(options = {}) {
  const { storage, now } = context(options)
  const url = options.url ?? globalThis.location?.href
  if (url) {
    try {
      const clickId = new URL(url).searchParams.get("kool_cid")
      if (clickId && CLICK_ID.test(clickId)) {
        const key = storage ?? memoryOnly
        const saved = { clickId, savedAt: now }
        unsaved.set(key, saved)
        try {
          if (storage) {
            storage.setItem(STORAGE_KEY, JSON.stringify(saved))
            unsaved.delete(key)
          }
        } catch {
          /* Storage may be disabled. */
        }
        return clickId
      }
    } catch {
      /* Invalid URLs do not discard existing attribution. */
    }
  }
  return getAttribution({ storage, now })
}

export function clearAttribution(options = {}) {
  const { storage } = context(options)
  unsaved.delete(storage ?? memoryOnly)
  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    /* No-op if storage is blocked. */
  }
}

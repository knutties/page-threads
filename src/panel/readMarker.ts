export interface ReadMarker {
  noteRendered(ids: number[]): void
  dispose(): void
}

/**
 * Batches read receipts: dedupes against everything already flushed,
 * debounces the POST, keeps failed ids queued for the next attempt.
 */
export function createReadMarker(opts: {
  flush: (ids: number[]) => Promise<void>
  debounceMs?: number
  isVisible?: () => boolean
  maxRetries?: number
}): ReadMarker {
  const debounceMs = opts.debounceMs ?? 2000
  const isVisible = opts.isVisible ?? (() => true)
  const maxRetries = opts.maxRetries ?? 5
  const pending = new Set<number>()
  const flushed = new Set<number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let failures = 0

  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      const ids = [...pending]
      if (!ids.length) return
      pending.clear()
      opts
        .flush(ids)
        .then(() => {
          if (disposed) return
          failures = 0
          for (const id of ids) flushed.add(id)
        })
        .catch(() => {
          if (disposed) return
          failures++
          if (failures > maxRetries) {
            // Give up on this batch: mark the ids flushed so they are not retried,
            // and reset so future messages get a fresh budget.
            for (const id of ids) flushed.add(id)
            failures = 0
            return
          }
          for (const id of ids) pending.add(id) // retry on the next schedule
          schedule()
        })
    }, debounceMs)
  }

  return {
    noteRendered(ids) {
      if (disposed || !isVisible()) return
      let added = false
      for (const id of ids) {
        if (!flushed.has(id) && !pending.has(id)) {
          pending.add(id)
          added = true
        }
      }
      if (added || pending.size) schedule()
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

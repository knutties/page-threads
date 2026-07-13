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
}): ReadMarker {
  const debounceMs = opts.debounceMs ?? 2000
  const isVisible = opts.isVisible ?? (() => true)
  const pending = new Set<number>()
  const flushed = new Set<number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

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
          for (const id of ids) flushed.add(id)
        })
        .catch(() => {
          if (disposed) return
          for (const id of ids) pending.add(id) // retry on the next schedule
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

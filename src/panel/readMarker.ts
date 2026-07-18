export interface ReadMarker {
  noteRendered(ids: number[], topicKey: string): void
  dispose(): void
}

/**
 * Batches read receipts per topic: dedupes against everything already flushed,
 * debounces the POST, keeps failed ids queued (under their own topic) for the
 * next attempt. On flush it marks all ids read in one call and reports the set
 * of distinct topics in the batch so the caller can zero each topic's badge.
 */
export function createReadMarker(opts: {
  flush: (ids: number[], topicKeys: string[]) => Promise<void>
  debounceMs?: number
  isVisible?: () => boolean
  maxRetries?: number
}): ReadMarker {
  const debounceMs = opts.debounceMs ?? 2000
  const isVisible = opts.isVisible ?? (() => true)
  const maxRetries = opts.maxRetries ?? 5
  const pending = new Map<string, Set<number>>() // topicKey → ids awaiting flush
  const flushed = new Set<number>() // ids confirmed read (globally unique, topic-agnostic)
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let failures = 0

  function pendingCount(): number {
    let n = 0
    for (const set of pending.values()) n += set.size
    return n
  }

  function isPending(id: number): boolean {
    for (const set of pending.values()) if (set.has(id)) return true
    return false
  }

  function requeue(batch: ReadonlyArray<readonly [string, readonly number[]]>): void {
    for (const [key, ids] of batch) {
      let set = pending.get(key)
      if (!set) {
        set = new Set()
        pending.set(key, set)
      }
      for (const id of ids) set.add(id)
    }
  }

  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      const batch = [...pending.entries()].map(([key, set]) => [key, [...set]] as const)
      pending.clear()
      const ids = batch.flatMap(([, list]) => list)
      if (!ids.length) return
      const topicKeys = batch.map(([key]) => key)
      opts
        .flush(ids, topicKeys)
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
          requeue(batch) // retry each id under its original topic
          schedule()
        })
    }, debounceMs)
  }

  return {
    noteRendered(ids, topicKey) {
      if (disposed || !isVisible()) return
      let added = false
      let set = pending.get(topicKey)
      for (const id of ids) {
        if (!flushed.has(id) && !isPending(id)) {
          if (!set) {
            set = new Set()
            pending.set(topicKey, set)
          }
          set.add(id)
          added = true
        }
      }
      if (added) failures = 0 // new content restarts the consecutive-failure budget
      if (added || pendingCount()) schedule()
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

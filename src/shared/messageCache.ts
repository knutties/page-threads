import type { StorageAreaLike } from './storage'
import type { ZulipMessage } from './zulipClient'

export const CACHE_CAP = 50
const KEY = 'msgCache'

export interface CacheEntry {
  messages: ZulipMessage[]
  at: number // last-access epoch ms (LRU)
}
export type MessageCacheMap = Record<string, CacheEntry>

export type CacheAction =
  | { type: 'put'; topicKey: string; messages: ZulipMessage[]; now: number; cap: number }
  | { type: 'touch'; topicKey: string; now: number }

function evictToCap(map: MessageCacheMap, cap: number): MessageCacheMap {
  const keys = Object.keys(map)
  if (keys.length <= cap) return map
  const ordered = keys.sort((a, b) => map[a]!.at - map[b]!.at) // oldest first
  const survivors = ordered.slice(ordered.length - cap)
  const next: MessageCacheMap = {}
  for (const k of survivors) next[k] = map[k]!
  return next
}

export function cacheReducer(map: MessageCacheMap, action: CacheAction): MessageCacheMap {
  switch (action.type) {
    case 'put': {
      const next: MessageCacheMap = { ...map, [action.topicKey]: { messages: action.messages, at: action.now } }
      return evictToCap(next, action.cap)
    }
    case 'touch': {
      const entry = map[action.topicKey]
      if (!entry) return map
      return { ...map, [action.topicKey]: { ...entry, at: action.now } }
    }
  }
}

export interface MessageCache {
  save(topicKey: string, messages: ZulipMessage[]): Promise<void>
  load(topicKey: string): Promise<ZulipMessage[] | null>
}

/**
 * Per-topicKey LRU cache of last-fetched messages in storage.local. Writes are
 * serialized (whole-map read-modify-write, since createStore can't delete keys,
 * which eviction needs). Best-effort: quota failures evict harder and retry once,
 * then give up silently.
 */
export function createMessageCache(
  area: StorageAreaLike = chrome.storage.local,
  now: () => number = () => Date.now()
): MessageCache {
  let chain: Promise<unknown> = Promise.resolve()

  async function readMap(): Promise<MessageCacheMap> {
    return ((await area.get(KEY))[KEY] as MessageCacheMap | undefined) ?? {}
  }

  function serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = chain.then(op)
    chain = next.then(
      () => {},
      () => {}
    )
    return next
  }

  return {
    save(topicKey, messages) {
      return serialize(async () => {
        const map = await readMap()
        let put = cacheReducer(map, { type: 'put', topicKey, messages, now: now(), cap: CACHE_CAP })
        try {
          await area.set({ [KEY]: put })
        } catch (e) {
          if (String((e as Error)?.message ?? e).includes('QUOTA_BYTES')) {
            put = cacheReducer(put, { type: 'put', topicKey, messages, now: now(), cap: Math.floor(CACHE_CAP / 2) })
            await area.set({ [KEY]: put }).catch(() => {}) // best-effort retry
          }
          // otherwise swallow — the cache is best-effort
        }
      })
    },
    load(topicKey) {
      return serialize(async () => {
        const map = await readMap()
        const entry = map[topicKey]
        if (!entry) return null
        await area.set({ [KEY]: cacheReducer(map, { type: 'touch', topicKey, now: now() }) }).catch(() => {})
        return entry.messages
      })
    },
  }
}

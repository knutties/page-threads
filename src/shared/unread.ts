import { browser } from './browser'
import { createStore, type StorageAreaLike, type StorageChangedLike, type Store } from './storage'

export type UnreadMap = Record<string, number>

export type UnreadAction =
  | { type: 'increment'; topicKey: string }
  | { type: 'set'; topicKey: string; count: number }
  | { type: 'zero'; topicKey: string }

export function unreadReducer(map: UnreadMap, action: UnreadAction): UnreadMap {
  switch (action.type) {
    case 'increment':
      return { ...map, [action.topicKey]: (map[action.topicKey] ?? 0) + 1 }
    case 'set':
      if (map[action.topicKey] === action.count) return map
      return { ...map, [action.topicKey]: action.count }
    case 'zero':
      if ((map[action.topicKey] ?? 0) === 0) return map
      return { ...map, [action.topicKey]: 0 }
  }
}

/** Per-topicKey unread counts, cached in chrome.storage.session (rebuildable). */
export function createUnreadStore(
  area: StorageAreaLike = browser.storage.session,
  changed: StorageChangedLike = browser.storage.onChanged,
  areaName = 'session'
): Store<UnreadMap> {
  return createStore('unread', {}, area, changed, areaName)
}

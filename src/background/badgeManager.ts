import { badgeText, keyFromTopicName } from '../shared/badge'
import { unreadReducer, type UnreadMap } from '../shared/unread'

export interface ResolvedTopic {
  topicKey: string
  /** null = the entity resolves but no Zulip topic exists yet (no thread). */
  topicName: string | null
}

export function createBadgeManager(deps: {
  resolveTopic(entityUri: string): Promise<ResolvedTopic | null>
  computeCount(topicName: string): Promise<number>
  setBadge(tabId: number, text: string): void
  onChange(map: UnreadMap): void
}) {
  let map: UnreadMap = {}
  let activeTabId: number | null = null
  let activeTopicKey: string | null = null

  function mutate(action: Parameters<typeof unreadReducer>[1]): void {
    const next = unreadReducer(map, action)
    if (next !== map) {
      map = next
      deps.onChange(map)
      // Repaint the active tab from cache (no network) if it owns this topic.
      const key = 'topicKey' in action ? action.topicKey : null
      if (activeTabId != null && key != null && key === activeTopicKey) {
        deps.setBadge(activeTabId, badgeText(map[key] ?? 0, true))
      }
    }
  }

  return {
    seed(initial: UnreadMap): void {
      map = { ...initial }
    },
    setActiveTab(tabId: number | null): void {
      // activeTopicKey belongs to whichever tab was last active; it is unknown for
      // a newly-active tab until refreshTab resolves it, so clear it on any change
      // to prevent a stale topic's event from repainting the wrong tab's badge.
      activeTabId = tabId
      activeTopicKey = null
    },
    async refreshTab(tabId: number, entityUri: string | null): Promise<void> {
      if (entityUri == null) {
        if (tabId === activeTabId) activeTopicKey = null
        deps.setBadge(tabId, '')
        return
      }
      const resolved = await deps.resolveTopic(entityUri)
      if (!resolved) {
        // Transient failure (creds not loaded yet on a cold-start poll, or a network
        // error) — never a confirmed "no thread". Leave the current badge as-is rather
        // than blanking a valid count; the next poll re-resolves it.
        return
      }
      if (tabId === activeTabId) activeTopicKey = resolved.topicKey
      if (resolved.topicName == null) {
        deps.setBadge(tabId, '') // resolvable entity, no thread yet
        return
      }
      const count = await deps.computeCount(resolved.topicName)
      map = unreadReducer(map, { type: 'set', topicKey: resolved.topicKey, count })
      deps.onChange(map)
      deps.setBadge(tabId, badgeText(count, true))
    },
    async refreshResolved(tabId: number, topicKey: string, topicName: string): Promise<void> {
      if (tabId === activeTabId) activeTopicKey = topicKey
      const count = await deps.computeCount(topicName)
      map = unreadReducer(map, { type: 'set', topicKey, count })
      deps.onChange(map)
      deps.setBadge(tabId, badgeText(count, true))
    },
    onMessageEvent(topicName: string, senderIsSelf: boolean): void {
      if (senderIsSelf) return
      const key = keyFromTopicName(topicName)
      if (!key) return
      mutate({ type: 'increment', topicKey: key })
    },
    onMarkedRead(topicKey: string): void {
      mutate({ type: 'zero', topicKey })
    },
  }
}

import { createCredentialsStore, type Credentials } from '../shared/credentials'
import type { PageEntity, PanelToSw, RuntimeToSw, SwToContent, SwToPanel } from '../shared/messages'
import { matchTopicByKey, topicKey as deriveTopicKey } from '../shared/topic'
import { createUnreadStore } from '../shared/unread'
import { ZulipClient } from '../shared/zulipClient'
import { createBadgeManager, type ResolvedTopic } from './badgeManager'
import { EventLoop } from './eventLoop'
import { createLifecycle } from './lifecycle'

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

const tabEntities = new Map<number, PageEntity>()
const ports = new Set<chrome.runtime.Port>()
const credentialsStore = createCredentialsStore()

// Badge plumbing. Credentials mirror (the lifecycle owns its own copy privately;
// the badge needs a client too). streamId/topics are cached to bound realm chatter.
// Placed above `lifecycle` (rather than after its setup, as in the brief) because
// `lifecycle`'s makeLoop onEvent closure references `badge` — defining `badge` first
// avoids a use-before-declaration lint error for what is otherwise a same-module
// forward reference safe at runtime.
let badgeCreds: Credentials | null = null
let cachedStreamId: number | null = null
let cachedTopics: { names: string[]; at: number } | null = null

async function loadTopics(client: ZulipClient, channel: string): Promise<string[]> {
  if (cachedTopics && Date.now() - cachedTopics.at < 60_000) return cachedTopics.names
  if (cachedStreamId == null) cachedStreamId = await client.getStreamId(channel)
  const names = await client.getTopics(cachedStreamId)
  cachedTopics = { names, at: Date.now() }
  return names
}

const unreadStore = createUnreadStore()

const badge = createBadgeManager({
  resolveTopic: async (entityUri): Promise<ResolvedTopic | null> => {
    if (!badgeCreds) return null
    try {
      const client = new ZulipClient(badgeCreds)
      const key = await deriveTopicKey(entityUri)
      const names = await loadTopics(client, badgeCreds.channelName)
      return { topicKey: key, topicName: matchTopicByKey(names, key) }
    } catch {
      return null
    }
  },
  computeCount: (topicName) =>
    badgeCreds ? new ZulipClient(badgeCreds).getUnreadCount(badgeCreds.channelName, topicName) : Promise.resolve(0),
  setBadge: (tabId, text) => {
    void chrome.action.setBadgeText({ tabId, text }).catch(() => {})
  },
  onChange: (map) => {
    void unreadStore.save(map).catch(() => {})
  },
})

void unreadStore.load().then((m) => badge.seed(m))
void credentialsStore.load().then((c) => {
  badgeCreds = c
  cachedStreamId = null
  cachedTopics = null
})
credentialsStore.watch((c) => {
  badgeCreds = c
  cachedStreamId = null // realm may have changed
  cachedTopics = null
})

async function refreshActiveTabBadge(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id == null) return
  badge.setActiveTab(tab.id)
  const entity = await entityForTab(tab.id)
  await badge.refreshTab(tab.id, entity?.entityUri ?? null)
}

chrome.alarms.create('badge', { periodInMinutes: 2 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'badge') void refreshActiveTabBadge()
})

const lifecycle = createLifecycle({
  loadCredentials: () => credentialsStore.load(),
  makeLoop: (creds) =>
    new EventLoop(new ZulipClient(creds), creds.channelName, {
      onEvent: (event) => {
        if (event.type === 'message' && event.message) {
          broadcast({ type: 'newMessage', topic: event.message.subject, message: event.message })
          badge.onMessageEvent(event.message.subject, event.message.sender_email === creds.email)
        } else if (event.type === 'update_message' && event.message_id != null) {
          if (event.rendered_content != null) {
            broadcast({ type: 'messageUpdated', messageId: event.message_id, renderedContent: event.rendered_content })
          }
          if (event.subject != null && event.orig_subject != null && event.subject !== event.orig_subject) {
            broadcast({ type: 'messageMoved', messageId: event.message_id, newTopic: event.subject })
          }
        } else if (event.type === 'delete_message' && event.message_id != null) {
          broadcast({ type: 'messageDeleted', messageId: event.message_id })
        } else if (
          event.type === 'reaction' &&
          event.message_id != null &&
          event.op != null &&
          event.emoji_name != null &&
          event.emoji_code != null &&
          event.reaction_type != null &&
          event.user_id != null
        ) {
          broadcast({
            type: 'reactionChanged',
            op: event.op,
            messageId: event.message_id,
            reaction: {
              emoji_name: event.emoji_name,
              emoji_code: event.emoji_code,
              reaction_type: event.reaction_type,
              user_id: event.user_id,
            },
          })
        }
      },
      onReconnect: () => broadcast({ type: 'reconnected' }),
    }),
})

void lifecycle.init()
credentialsStore.watch((c) => lifecycle.setCredentials(c))

function broadcast(msg: SwToPanel): void {
  for (const port of ports) {
    try {
      port.postMessage(msg)
    } catch {
      removePort(port) // postMessage throws once the port is gone; drop it
    }
  }
}

function removePort(port: chrome.runtime.Port): void {
  // Idempotent: only notify the lifecycle when this port was actually still tracked,
  // so a dead-port cleanup in broadcast() and a later onDisconnect can't double-count.
  if (ports.delete(port)) lifecycle.portDisconnected()
}

/** tabEntities is a cache; on a miss (SW restarted since the page loaded), ask the tab. */
async function entityForTab(tabId: number): Promise<PageEntity | null> {
  const cached = tabEntities.get(tabId)
  if (cached) return cached
  try {
    const msg: SwToContent = { type: 'queryEntity' }
    const entity = (await chrome.tabs.sendMessage(tabId, msg)) as PageEntity | undefined
    if (entity) {
      tabEntities.set(tabId, entity)
      return entity
    }
  } catch {
    // No content script in this tab: chrome:// page, or orphaned script after an extension reload.
  }
  return null
}

let lastPushedUri: string | null | undefined // undefined = nothing pushed yet
let pushGeneration = 0

async function pushActiveEntity(): Promise<void> {
  const generation = ++pushGeneration
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    const entity = tab?.id != null ? await entityForTab(tab.id) : null
    if (generation !== pushGeneration) return // a newer evaluation superseded this one
    const uri = entity?.entityUri ?? null
    if (uri !== lastPushedUri) {
      lastPushedUri = uri
      broadcast({ type: 'activeEntity', entity })
    }
  } catch {
    // Transient query failure; the next trigger re-evaluates.
  }
}

chrome.tabs.onActivated.addListener(() => {
  void pushActiveEntity()
  void refreshActiveTabBadge()
})

chrome.runtime.onMessage.addListener((msg: RuntimeToSw, sender) => {
  if (msg.type === 'pageEntity' && sender.tab?.id != null) {
    tabEntities.set(sender.tab.id, { entityUri: msg.entityUri, title: msg.title })
    if (sender.tab.active) void pushActiveEntity()
  } else if (msg.type === 'pageBlocked' && sender.tab?.id != null) {
    tabEntities.delete(sender.tab.id)
    if (sender.tab.active) void pushActiveEntity()
  } else if (msg.type === 'credentialsChanged') {
    void lifecycle.reloadCredentials()
  } else if (msg.type === 'markedRead') {
    badge.onMarkedRead(msg.topicKey)
  } else if (msg.type === 'topicResolved') {
    // The side panel is an extension page, so sender.tab is undefined. The panel
    // is window-scoped and only resolves the active tab's thread, so badge that tab.
    void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      if (tab?.id != null) void badge.refreshResolved(tab.id, msg.topicKey, msg.topicName)
    })
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  tabEntities.delete(tabId)
  void pushActiveEntity()
  void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void pushActiveEntity()
})

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A tab that navigated somewhere content scripts can't run must not keep a stale entity.
  if (info.status === 'loading' && info.url && !/^https?:/.test(info.url)) {
    tabEntities.delete(tabId)
    void pushActiveEntity()
  }
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return
  ports.add(port)

  lifecycle.portConnected()

  port.onMessage.addListener((msg: PanelToSw) => {
    if (msg.type === 'getActiveEntity') {
      void chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then(async ([tab]) => {
          const entity = tab?.id != null ? await entityForTab(tab.id) : null
          const reply: SwToPanel = { type: 'activeEntity', entity }
          port.postMessage(reply)
        })
        .catch(() => {
          try {
            port.postMessage({ type: 'activeEntity', entity: null } satisfies SwToPanel)
          } catch {
            // port already gone; nothing to reply to
          }
        })
    }
  })

  port.onDisconnect.addListener(() => {
    removePort(port)
  })
})

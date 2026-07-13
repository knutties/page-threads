import { createCredentialsStore, type Credentials } from '../shared/credentials'
import type { PageEntity, PanelToSw, RuntimeToSw, SwToContent, SwToPanel } from '../shared/messages'
import { ZulipClient } from '../shared/zulipClient'
import { EventLoop } from './eventLoop'

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

const tabEntities = new Map<number, PageEntity>()
const ports = new Set<chrome.runtime.Port>()
const credentialsStore = createCredentialsStore()
let credentials: Credentials | null = null
let loop: EventLoop | null = null

void credentialsStore.load().then((c) => {
  credentials = c
  startLoopIfReady()
})

// Belt-and-braces alongside the credentialsChanged message: a missed message
// cannot leave a loop running against stale credentials.
credentialsStore.watch((c) => {
  credentials = c
  restartLoop()
})

function startLoopIfReady(): void {
  if (loop || !credentials || ports.size === 0) return
  const client = new ZulipClient(credentials)
  loop = new EventLoop(client, credentials.channelName, {
    onEvent: (event) => {
      if (event.type === 'message' && event.message) {
        broadcast({ type: 'newMessage', topic: event.message.subject, message: event.message })
      }
    },
    onReconnect: () => broadcast({ type: 'reconnected' }),
  })
  void loop.start()
}

function restartLoop(): void {
  loop?.stop()
  loop = null
  startLoopIfReady()
}

function broadcast(msg: SwToPanel): void {
  for (const port of ports) {
    try {
      port.postMessage(msg)
    } catch {
      ports.delete(port) // postMessage throws once the port is gone; drop it
    }
  }
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

chrome.tabs.onActivated.addListener(() => void pushActiveEntity())

chrome.runtime.onMessage.addListener((msg: RuntimeToSw, sender) => {
  if (msg.type === 'pageEntity' && sender.tab?.id != null) {
    tabEntities.set(sender.tab.id, { entityUri: msg.entityUri, title: msg.title })
    if (sender.tab.active) void pushActiveEntity()
  } else if (msg.type === 'credentialsChanged') {
    void credentialsStore.load().then((c) => {
      credentials = c
      restartLoop()
    })
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  tabEntities.delete(tabId)
  void pushActiveEntity()
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return
  ports.add(port)

  startLoopIfReady()

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
    ports.delete(port)
    if (ports.size === 0) {
      loop?.stop()
      loop = null
    }
  })
})

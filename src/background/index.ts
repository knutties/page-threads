import { config } from '../config'
import type { ContentToSw, PageEntity, PanelToSw, SwToPanel } from '../shared/messages'
import { ZulipClient } from '../shared/zulipClient'
import { EventLoop } from './eventLoop'

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

const tabEntities = new Map<number, PageEntity>()
const ports = new Set<chrome.runtime.Port>()
const client = new ZulipClient(config)
let loop: EventLoop | null = null

function broadcast(msg: SwToPanel): void {
  for (const port of ports) {
    try {
      port.postMessage(msg)
    } catch {
      ports.delete(port) // postMessage throws once the port is gone; drop it
    }
  }
}

let lastPushedUri: string | null | undefined // undefined = nothing pushed yet
let pushGeneration = 0

async function pushActiveEntity(): Promise<void> {
  const generation = ++pushGeneration
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (generation !== pushGeneration) return // a newer evaluation superseded this one
    const entity = tab?.id != null ? tabEntities.get(tab.id) ?? null : null
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

chrome.runtime.onMessage.addListener((msg: ContentToSw, sender) => {
  if (msg.type === 'pageEntity' && sender.tab?.id != null) {
    tabEntities.set(sender.tab.id, { entityUri: msg.entityUri, title: msg.title })
    if (sender.tab.active) void pushActiveEntity()
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  tabEntities.delete(tabId)
  void pushActiveEntity()
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return
  ports.add(port)

  if (!loop) {
    loop = new EventLoop(client, config.channelName, {
      onEvent: (event) => {
        if (event.type === 'message' && event.message) {
          broadcast({ type: 'newMessage', topic: event.message.subject, message: event.message })
        }
      },
      onReconnect: () => broadcast({ type: 'reconnected' }),
    })
    void loop.start()
  }

  port.onMessage.addListener((msg: PanelToSw) => {
    if (msg.type === 'getActiveEntity') {
      void chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then(([tab]) => {
          const entity = tab?.id != null ? tabEntities.get(tab.id) ?? null : null
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

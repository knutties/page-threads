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
  for (const port of ports) port.postMessage(msg)
}

chrome.runtime.onMessage.addListener((msg: ContentToSw, sender) => {
  if (msg.type === 'pageEntity' && sender.tab?.id != null) {
    tabEntities.set(sender.tab.id, { entityUri: msg.entityUri, title: msg.title })
  }
})

chrome.tabs.onRemoved.addListener((tabId) => tabEntities.delete(tabId))

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
      void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
        const entity = tab?.id != null ? tabEntities.get(tab.id) ?? null : null
        const reply: SwToPanel = { type: 'activeEntity', entity }
        port.postMessage(reply)
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

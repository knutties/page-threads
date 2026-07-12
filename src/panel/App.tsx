import { useEffect, useReducer, useRef, useState } from 'preact/hooks'
import { config } from '../config'
import type { PageEntity, PanelToSw, SwToPanel } from '../shared/messages'
import { matchTopicByKey, topicKey, topicName } from '../shared/topic'
import { ZulipClient } from '../shared/zulipClient'
import { Composer } from './Composer'
import { topicMatchesKey } from './eventMatch'
import { ThreadView } from './ThreadView'
import { threadReducer } from './threadState'

const client = new ZulipClient(config)

interface Thread {
  entity: PageEntity
  key: string
  /** Exact topic name on the server, or null when no discussion exists yet. */
  existingTopic: string | null
}

function headerMessage(entity: PageEntity): string {
  const representativeUrl = entity.entityUri.replace(/^web:/, '')
  return [
    `🔗 Discussion for: ${entity.title}`,
    `Entity: \`${entity.entityUri}\` (resolver web@1)`,
    `Link: ${representativeUrl}`,
    `Started by ${config.email}`,
  ].join('\n')
}

export function App() {
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, dispatch] = useReducer(threadReducer, [])
  const [error, setError] = useState<string | null>(null)
  const threadRef = useRef<Thread | null>(null)
  threadRef.current = thread

  useEffect(() => {
    let disposed = false
    let port: chrome.runtime.Port
    let pingTimer: number | undefined

    const handleMessage = (msg: SwToPanel) => {
      if (msg.type === 'activeEntity') {
        if (msg.entity) {
          initThread(msg.entity).catch((e) => setError(errText(e)))
        } else {
          setError('No page detected. Reload the tab, then reopen the panel.')
        }
      } else if (msg.type === 'newMessage') {
        const t = threadRef.current
        if (t && topicMatchesKey(msg.topic, t.key)) {
          if (!t.existingTopic) setThread({ ...t, existingTopic: msg.topic })
          dispatch({ type: 'append', message: msg.message })
        }
      } else if (msg.type === 'reconnected') {
        const t = threadRef.current
        if (t?.existingTopic) loadHistory(t.existingTopic).catch(() => {})
      }
    }

    function connect(isReconnect: boolean) {
      port = chrome.runtime.connect({ name: 'panel' })
      port.onMessage.addListener(handleMessage)
      // Port messages are what reset the MV3 service-worker idle timer; the
      // long-poll fetch alone does not keep it alive. 20s < the 30s idle limit.
      pingTimer = window.setInterval(() => {
        try {
          port.postMessage({ type: 'ping' } satisfies PanelToSw)
        } catch {
          // Port already dead; onDisconnect is about to fire.
        }
      }, 20_000)
      port.onDisconnect.addListener(() => {
        window.clearInterval(pingTimer)
        if (disposed) return
        // SW was torn down; reconnecting wakes it and restarts the event loop.
        window.setTimeout(() => {
          if (!disposed) connect(true)
        }, 200)
      })
      const t = threadRef.current
      if (!isReconnect || !t) {
        port.postMessage({ type: 'getActiveEntity' } satisfies PanelToSw)
      } else if (t.existingTopic) {
        // Already resolved: skip re-init (SW tab map may be empty after restart),
        // just catch up on anything missed while the port was down.
        loadHistory(t.existingTopic).catch(() => {})
      }
    }

    connect(false)
    return () => {
      disposed = true
      window.clearInterval(pingTimer)
      port.disconnect()
    }
  }, [])

  async function initThread(entity: PageEntity) {
    const key = await topicKey(entity.entityUri)
    const streamId = await client.getStreamId(config.channelName)
    const topics = await client.getTopics(streamId)
    const existingTopic = matchTopicByKey(topics, key)
    setThread({ entity, key, existingTopic })
    if (existingTopic) await loadHistory(existingTopic)
  }

  async function loadHistory(topic: string) {
    dispatch({ type: 'history', messages: await client.getMessages(config.channelName, topic) })
  }

  async function send(text: string) {
    const t = threadRef.current
    if (!t) return
    setError(null)
    try {
      let topic = t.existingTopic
      if (!topic) {
        topic = topicName(t.entity.title, t.key)
        // Header first (spec §6.2); on failure retry once, then proceed regardless —
        // the topicKey suffix still makes the thread resolvable.
        try {
          await client.sendMessage(config.channelName, topic, headerMessage(t.entity))
        } catch {
          await client.sendMessage(config.channelName, topic, headerMessage(t.entity)).catch(() => {})
        }
        setThread({ ...t, existingTopic: topic })
      }
      await client.sendMessage(config.channelName, topic, text)
      await loadHistory(topic)
    } catch (e) {
      setError(errText(e))
    }
  }

  return (
    <div class="app">
      <header title={thread?.entity.entityUri}>{thread ? thread.entity.title : 'PageThreads'}</header>
      {error && (
        <div class="error" role="alert" onClick={() => setError(null)}>
          {error} <small>(click to dismiss)</small>
        </div>
      )}
      <ThreadView messages={messages} hasThread={!!thread?.existingTopic} />
      <Composer onSend={(text) => void send(text)} disabled={!thread} />
    </div>
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

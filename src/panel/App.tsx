import { useEffect, useReducer, useRef, useState } from 'preact/hooks'
import { config } from '../config'
import type { PageEntity, PanelToSw, SwToPanel } from '../shared/messages'
import { matchTopicByKey, topicKey, topicName } from '../shared/topic'
import { ZulipClient } from '../shared/zulipClient'
import { Composer } from './Composer'
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
    const port = chrome.runtime.connect({ name: 'panel' })
    port.onMessage.addListener((msg: SwToPanel) => {
      if (msg.type === 'activeEntity') {
        if (msg.entity) {
          initThread(msg.entity).catch((e) => setError(errText(e)))
        } else {
          setError('No page detected. Reload the tab, then reopen the panel.')
        }
      } else if (msg.type === 'newMessage') {
        const t = threadRef.current
        if (t?.existingTopic && msg.topic === t.existingTopic) {
          dispatch({ type: 'append', message: msg.message })
        }
      } else if (msg.type === 'reconnected') {
        const t = threadRef.current
        if (t?.existingTopic) loadHistory(t.existingTopic).catch(() => {})
      }
    })
    const req: PanelToSw = { type: 'getActiveEntity' }
    port.postMessage(req)
    return () => port.disconnect()
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

import { useEffect, useReducer, useRef, useState } from 'preact/hooks'
import { config } from '../config'
import type { PageEntity, PanelToSw, SwToPanel } from '../shared/messages'
import { createSettingsStore, DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { matchTopicByKey, topicKey, topicName } from '../shared/topic'
import { ZulipClient } from '../shared/zulipClient'
import { Composer } from './Composer'
import { Drafts } from './drafts'
import { topicMatchesKey } from './eventMatch'
import { panelTarget, type PanelTargetState } from './panelTarget'
import { ThreadView } from './ThreadView'
import { threadReducer } from './threadState'

const client = new ZulipClient(config)
const drafts = new Drafts()
const settingsStore = createSettingsStore()

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
  const [pinned, setPinned] = useState(false)
  const [draftText, setDraftText] = useState('')

  const threadRef = useRef<Thread | null>(null)
  threadRef.current = thread
  const targetRef = useRef<PanelTargetState>({ pinned: false, currentUri: null })
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)
  const portRef = useRef<chrome.runtime.Port | null>(null)

  function onDraftInput(text: string) {
    setDraftText(text)
    const uri = threadRef.current?.entity.entityUri
    if (uri) drafts.set(uri, text)
  }

  function requestActiveEntity() {
    portRef.current?.postMessage({ type: 'getActiveEntity' } satisfies PanelToSw)
  }

  function applyPush(entity: PageEntity | null) {
    const { state, action } = panelTarget(
      targetRef.current,
      { type: 'push', entity },
      settingsRef.current.onNonWebPage
    )
    targetRef.current = state
    if (action === 'switch' && entity) {
      setError(null)
      setThread(null)
      dispatch({ type: 'history', messages: [] })
      setDraftText(drafts.get(entity.entityUri))
      initThread(entity).catch((e) => {
        setError(errText(e))
        targetRef.current = panelTarget(
          targetRef.current,
          { type: 'initFailed', uri: entity.entityUri },
          settingsRef.current.onNonWebPage
        ).state
      })
    } else if (action === 'clear') {
      setThread(null)
      dispatch({ type: 'history', messages: [] })
      setDraftText('')
    }
  }

  useEffect(() => {
    void settingsStore.load().then((s) => (settingsRef.current = s))
    return settingsStore.watch((s) => (settingsRef.current = s))
  }, [])

  useEffect(() => {
    let disposed = false
    let port: chrome.runtime.Port
    let pingTimer: number | undefined

    const handleMessage = (msg: SwToPanel) => {
      if (msg.type === 'activeEntity') {
        applyPush(msg.entity)
      } else if (msg.type === 'newMessage') {
        const t = threadRef.current
        if (t && topicMatchesKey(msg.topic, t.key)) {
          if (!t.existingTopic) setThread({ ...t, existingTopic: msg.topic })
          dispatch({ type: 'append', message: msg.message })
        }
      } else if (msg.type === 'reconnected') {
        const t = threadRef.current
        if (t?.existingTopic) loadHistory(t.existingTopic, t.entity.entityUri).catch(() => {})
      }
    }

    function connect(isReconnect: boolean) {
      port = chrome.runtime.connect({ name: 'panel' })
      portRef.current = port
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
        loadHistory(t.existingTopic, t.entity.entityUri).catch(() => {})
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
    // A later push may have switched targets while we awaited; don't clobber it.
    if (targetRef.current.currentUri !== entity.entityUri) return
    setThread({ entity, key, existingTopic })
    if (existingTopic) await loadHistory(existingTopic, entity.entityUri)
  }

  async function loadHistory(topic: string, forUri: string) {
    const messages = await client.getMessages(config.channelName, topic)
    // The user may have switched targets while the fetch was in flight.
    if (targetRef.current.currentUri !== forUri) return
    dispatch({ type: 'history', messages })
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
      drafts.clear(t.entity.entityUri)
      if (targetRef.current.currentUri === t.entity.entityUri) setDraftText('')
      await loadHistory(topic, t.entity.entityUri)
    } catch (e) {
      setError(errText(e))
    }
  }

  function togglePin() {
    const event = targetRef.current.pinned ? ({ type: 'unpin' } as const) : ({ type: 'pin' } as const)
    const { state, action } = panelTarget(targetRef.current, event, settingsRef.current.onNonWebPage)
    targetRef.current = state
    setPinned(state.pinned)
    if (action === 'refresh') requestActiveEntity()
  }

  return (
    <div class="app">
      <header title={thread?.entity.entityUri}>
        <span class="title">{thread ? thread.entity.title : 'PageThreads'}</span>
        <button
          class={pinned ? 'pin pinned' : 'pin'}
          title={pinned ? 'Unpin: follow the active tab' : 'Pin: keep this thread while browsing'}
          onClick={togglePin}
        >
          📌
        </button>
      </header>
      {error && (
        <div class="error" role="alert">
          <span onClick={() => setError(null)}>
            {error} <small>(click to dismiss)</small>
          </span>
          {!thread && (
            <button class="retry" onClick={requestActiveEntity}>
              Retry
            </button>
          )}
        </div>
      )}
      <ThreadView messages={messages} hasThread={!!thread?.existingTopic} noPage={!thread && !error} />
      <Composer value={draftText} onInput={onDraftInput} onSend={(text) => void send(text)} disabled={!thread} />
    </div>
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

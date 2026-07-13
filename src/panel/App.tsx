import { useEffect, useReducer, useRef, useState } from 'preact/hooks'
import { createCredentialsStore, type Credentials } from '../shared/credentials'
import type { PageEntity, PanelToSw, RuntimeToSw, SwToPanel } from '../shared/messages'
import { createSettingsStore, DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { matchTopicByKey, topicKey, topicName } from '../shared/topic'
import { ZulipClient } from '../shared/zulipClient'
import { AccountView } from './AccountView'
import { Composer } from './Composer'
import { Drafts } from './drafts'
import { topicMatchesKey } from './eventMatch'
import { panelTarget, type PanelTargetState } from './panelTarget'
import { SetupView } from './SetupView'
import { ThreadView } from './ThreadView'
import { threadReducer } from './threadState'

const drafts = new Drafts()
const settingsStore = createSettingsStore()
const credentialsStore = createCredentialsStore()

interface Thread {
  entity: PageEntity
  key: string
  /** Exact topic name on the server, or null when no discussion exists yet. */
  existingTopic: string | null
}

function headerMessage(entity: PageEntity, email: string): string {
  const representativeUrl = entity.entityUri.replace(/^web:/, '')
  return [
    `🔗 Discussion for: ${entity.title}`,
    `Entity: \`${entity.entityUri}\` (resolver web@1)`,
    `Link: ${representativeUrl}`,
    `Started by ${email}`,
  ].join('\n')
}

function notifySwCredentialsChanged(): void {
  const msg: RuntimeToSw = { type: 'credentialsChanged' }
  void chrome.runtime.sendMessage(msg).catch(() => {})
}

export function App() {
  // undefined = still loading from storage; null = not configured (show setup)
  const [credentials, setCredentials] = useState<Credentials | null | undefined>(undefined)
  const [fullName, setFullName] = useState<string | undefined>(undefined)
  const [showAccount, setShowAccount] = useState(false)
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, dispatch] = useReducer(threadReducer, [])
  const [error, setError] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [sending, setSending] = useState(false)

  const threadRef = useRef<Thread | null>(null)
  threadRef.current = thread
  const targetRef = useRef<PanelTargetState>({ pinned: false, currentUri: null })
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const clientRef = useRef<ZulipClient | null>(null)
  const credsRef = useRef<Credentials | null>(null)

  function applyCredentials(c: Credentials | null) {
    credsRef.current = c
    clientRef.current = c ? new ZulipClient(c) : null
    setCredentials(c)
  }

  useEffect(() => {
    void credentialsStore.load().then(applyCredentials)
  }, [])

  useEffect(() => {
    void settingsStore.load().then((s) => (settingsRef.current = s))
    return settingsStore.watch((s) => (settingsRef.current = s))
  }, [])

  async function completeSetup(c: Credentials) {
    await credentialsStore.save(c)
    applyCredentials(c)
    notifySwCredentialsChanged()
  }

  async function signOut() {
    await credentialsStore.clear()
    targetRef.current = { pinned: false, currentUri: null }
    setThread(null)
    dispatch({ type: 'history', messages: [] })
    setDraftText('')
    setPinned(false)
    setError(null)
    setShowAccount(false)
    setFullName(undefined)
    applyCredentials(null)
    notifySwCredentialsChanged()
  }

  function requestActiveEntity() {
    portRef.current?.postMessage({ type: 'getActiveEntity' } satisfies PanelToSw)
  }

  function onDraftInput(text: string) {
    setDraftText(text)
    const uri = threadRef.current?.entity.entityUri
    if (uri) drafts.set(uri, text)
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
    if (!credentials) return
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
      portRef.current = null
      port.disconnect()
    }
  }, [credentials])

  async function initThread(entity: PageEntity) {
    const client = clientRef.current
    const creds = credsRef.current
    if (!client || !creds) return
    const key = await topicKey(entity.entityUri)
    const streamId = await client.getStreamId(creds.channelName)
    const topics = await client.getTopics(streamId)
    const existingTopic = matchTopicByKey(topics, key)
    // A later push may have switched targets while we awaited; don't clobber it.
    if (targetRef.current.currentUri !== entity.entityUri) return
    setThread({ entity, key, existingTopic })
    if (existingTopic) await loadHistory(existingTopic, entity.entityUri)
  }

  async function loadHistory(topic: string, forUri: string) {
    const client = clientRef.current
    const creds = credsRef.current
    if (!client || !creds) return
    const messages = await client.getMessages(creds.channelName, topic)
    // The user may have switched targets while the fetch was in flight.
    if (targetRef.current.currentUri !== forUri) return
    dispatch({ type: 'history', messages })
  }

  async function send(text: string) {
    const t = threadRef.current
    const client = clientRef.current
    const creds = credsRef.current
    if (!t || !client || !creds) return
    if (sending) return
    setSending(true)
    setError(null)
    try {
      let topic = t.existingTopic
      if (!topic) {
        topic = topicName(t.entity.title, t.key)
        // Header first (spec §6.2); on failure retry once, then proceed regardless —
        // the topicKey suffix still makes the thread resolvable.
        try {
          await client.sendMessage(creds.channelName, topic, headerMessage(t.entity, creds.email))
        } catch {
          await client.sendMessage(creds.channelName, topic, headerMessage(t.entity, creds.email)).catch(() => {})
        }
        setThread({ ...t, existingTopic: topic })
      }
      await client.sendMessage(creds.channelName, topic, text)
      drafts.clear(t.entity.entityUri)
      if (targetRef.current.currentUri === t.entity.entityUri) setDraftText('')
      await loadHistory(topic, t.entity.entityUri)
    } catch (e) {
      setError(errText(e))
    } finally {
      setSending(false)
    }
  }

  function togglePin() {
    const event = targetRef.current.pinned ? ({ type: 'unpin' } as const) : ({ type: 'pin' } as const)
    const { state, action } = panelTarget(targetRef.current, event, settingsRef.current.onNonWebPage)
    targetRef.current = state
    setPinned(state.pinned)
    if (action === 'refresh') requestActiveEntity()
  }

  function openAccount() {
    setShowAccount(true)
    const client = clientRef.current
    if (!fullName && client) {
      client
        .getOwnUser()
        .then((u) => {
          // The account may have changed while the fetch was in flight.
          if (clientRef.current === client) setFullName(u.fullName)
        })
        .catch(() => {})
    }
  }

  if (credentials === undefined) {
    return <div class="empty">Loading…</div>
  }
  if (credentials === null) {
    return <SetupView onComplete={(c) => void completeSetup(c)} />
  }
  if (showAccount) {
    return (
      <AccountView
        credentials={credentials}
        fullName={fullName}
        onClose={() => setShowAccount(false)}
        onSignOut={() => void signOut()}
      />
    )
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
        <button class="pin" title="Account" onClick={openAccount}>
          ⚙️
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
      <Composer value={draftText} onInput={onDraftInput} onSend={(text) => void send(text)} disabled={!thread} busy={sending} />
    </div>
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

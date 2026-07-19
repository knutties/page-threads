import { useEffect, useReducer, useRef, useState } from 'preact/hooks'
import { browser } from '../shared/browser'
import { createCredentialsStore, type Credentials } from '../shared/credentials'
import type { PageEntity, PanelToSw, RuntimeToSw, SwToPanel } from '../shared/messages'
import { createMessageCache } from '../shared/messageCache'
import { isNetworkError } from '../shared/netError'
import { createSettingsStore, DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { matchTopicByKey, topicKey, topicName } from '../shared/topic'
import { ZulipClient } from '../shared/zulipClient'
import { AccountView } from './AccountView'
import { Composer } from './Composer'
import { Drafts } from './drafts'
import { topicMatchesKey } from './eventMatch'
import { headerMessage } from './headerMessage'
import { headerSubtitle } from './headerSubtitle'
import type { ReactionInput } from './MessageView'
import { panelTarget, type PanelTargetState } from './panelTarget'
import { createReadMarker, type ReadMarker } from './readMarker'
import { shouldGate } from './resolveGate'
import { SetupView } from './SetupView'
import { ThreadView } from './ThreadView'
import { threadReducer } from './threadState'

const drafts = new Drafts()
const settingsStore = createSettingsStore()
const credentialsStore = createCredentialsStore()
const messageCache = createMessageCache()

interface Thread {
  entity: PageEntity
  key: string
  existingTopic: string | null
}

function notifySwCredentialsChanged(): void {
  const msg: RuntimeToSw = { type: 'credentialsChanged' }
  void browser.runtime.sendMessage(msg).catch(() => {})
}

export function App() {
  const [credentials, setCredentials] = useState<Credentials | null | undefined>(undefined)
  const [fullName, setFullName] = useState<string | undefined>(undefined)
  const [ownUserId, setOwnUserId] = useState<number | null>(null)
  const [showAccount, setShowAccount] = useState(false)
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, dispatch] = useReducer(threadReducer, [])
  const [error, setError] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [sending, setSending] = useState(false)
  const [offline, setOffline] = useState(false)
  const [editState, setEditState] = useState<{ id: number; raw: string } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [pendingEntity, setPendingEntity] = useState<PageEntity | null>(null)

  const threadRef = useRef<Thread | null>(null)
  threadRef.current = thread
  const targetRef = useRef<PanelTargetState>({ pinned: false, currentUri: null })
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const clientRef = useRef<ZulipClient | null>(null)
  const credsRef = useRef<Credentials | null>(null)
  const sendingRef = useRef(false) // synchronous double-send latch (backlog #3)
  const initGenRef = useRef(0) // per-init generation token (backlog #7)
  const readMarkerRef = useRef<ReadMarker | null>(null)
  const settingsLoadedRef = useRef(false)

  function applyCredentials(c: Credentials | null) {
    credsRef.current = c
    clientRef.current = c ? new ZulipClient(c) : null
    readMarkerRef.current?.dispose()
    readMarkerRef.current = c
      ? createReadMarker({
          flush: async (ids, topicKeys) => {
            await (clientRef.current?.markRead(ids) ?? Promise.resolve())
            for (const key of topicKeys) {
              const msg: RuntimeToSw = { type: 'markedRead', topicKey: key }
              void browser.runtime.sendMessage(msg).catch(() => {})
            }
          },
          isVisible: () => document.visibilityState === 'visible',
        })
      : null
    setCredentials(c)
    if (c && clientRef.current) {
      const client = clientRef.current
      client
        .getOwnUser()
        .then((u) => {
          if (clientRef.current === client) {
            setFullName(u.fullName)
            setOwnUserId(u.userId)
          }
        })
        .catch(() => {})
    } else {
      setFullName(undefined)
      setOwnUserId(null)
    }
  }

  function resetThreadState() {
    targetRef.current = { pinned: false, currentUri: null }
    setThread(null)
    dispatch({ type: 'history', messages: [] })
    setDraftText('')
    setPinned(false)
    setError(null)
    setEditState(null)
    setPendingEntity(null)
    setOffline(false)
  }

  useEffect(() => {
    void credentialsStore.load().then(applyCredentials)
    // Backlog #1: a sign-out or account switch in ANY window updates this panel too.
    return credentialsStore.watch((c) => {
      resetThreadState()
      applyCredentials(c)
    })
  }, [])

  useEffect(() => {
    const onOnline = () => refreshCurrentThread()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  useEffect(() => {
    void settingsStore.load().then((s) => {
      settingsRef.current = s
      settingsLoadedRef.current = true
    })
    return settingsStore.watch((s) => (settingsRef.current = s))
  }, [])

  async function completeSetup(c: Credentials) {
    await credentialsStore.save(c)
    // The credentialsStore.watch above fires for this same save and applies it;
    // apply directly too so the transition is immediate even if events lag.
    resetThreadState()
    applyCredentials(c)
    notifySwCredentialsChanged()
  }

  async function signOut() {
    await credentialsStore.clear()
    resetThreadState()
    setShowAccount(false)
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
    if (!settingsLoadedRef.current) {
      // Don't resolve anything (which could reveal the page to the realm in
      // strict mode) until we know the user's resolveMode. Re-request shortly.
      window.setTimeout(() => requestActiveEntity(), 50)
      return
    }
    const { state, action } = panelTarget(
      targetRef.current,
      { type: 'push', entity },
      settingsRef.current.onNonWebPage
    )
    targetRef.current = state
    if (action === 'switch' && entity) {
      setError(null)
      setThread(null)
      setEditState(null)
      setOffline(false)
      dispatch({ type: 'history', messages: [] })
      setDraftText(drafts.get(entity.entityUri))
      if (shouldGate(settingsRef.current.resolveMode)) {
        setPendingEntity(entity)
      } else {
        setPendingEntity(null)
        void resolveEntity(entity)
      }
    } else if (action === 'clear') {
      setPendingEntity(null)
      setThread(null)
      setEditState(null)
      setOffline(false)
      dispatch({ type: 'history', messages: [] })
      setDraftText('')
    }
  }

  function resolveEntity(entity: PageEntity) {
    const generation = ++initGenRef.current
    return initThread(entity).catch((e) => {
      // Backlog #7: only the LATEST init may surface failure / re-arm the reducer.
      if (generation !== initGenRef.current) return
      setError(errText(e))
      targetRef.current = panelTarget(
        targetRef.current,
        { type: 'initFailed', uri: entity.entityUri },
        settingsRef.current.onNonWebPage
      ).state
    })
  }

  function checkForDiscussion() {
    const entity = pendingEntity
    if (!entity) return
    setPendingEntity(null)
    void resolveEntity(entity)
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
      } else if (msg.type === 'messageUpdated') {
        dispatch({ type: 'update', id: msg.messageId, content: msg.renderedContent })
      } else if (msg.type === 'messageDeleted') {
        dispatch({ type: 'remove', id: msg.messageId })
        setEditState((cur) => (cur?.id === msg.messageId ? null : cur))
      } else if (msg.type === 'messageMoved') {
        const t = threadRef.current
        // Removed from THIS thread if it moved to a topic that isn't ours.
        if (t && !topicMatchesKey(msg.newTopic, t.key)) {
          dispatch({ type: 'remove', id: msg.messageId })
          setEditState((cur) => (cur?.id === msg.messageId ? null : cur))
        }
      } else if (msg.type === 'reactionChanged') {
        dispatch({ type: 'reaction', op: msg.op, id: msg.messageId, reaction: msg.reaction })
      } else if (msg.type === 'reconnected') {
        refreshCurrentThread()
      }
    }

    function connect(isReconnect: boolean) {
      port = browser.runtime.connect({ name: 'panel' })
      portRef.current = port
      port.onMessage.addListener(handleMessage)
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
        window.setTimeout(() => {
          if (!disposed) connect(true)
        }, 200)
      })
      const t = threadRef.current
      if (!isReconnect || !t) {
        port.postMessage({ type: 'getActiveEntity' } satisfies PanelToSw)
      } else {
        refreshCurrentThread()
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
    try {
      const streamId = await client.getStreamId(creds.channelName)
      const topics = await client.getTopics(streamId)
      const existingTopic = matchTopicByKey(topics, key)
      if (targetRef.current.currentUri !== entity.entityUri) return
      setThread({ entity, key, existingTopic })
      if (existingTopic) {
        const msg: RuntimeToSw = { type: 'topicResolved', topicKey: key, topicName: existingTopic }
        void browser.runtime.sendMessage(msg).catch(() => {})
        await loadHistory(existingTopic, entity.entityUri, key)
      } else {
        setOffline(false) // resolved online; no thread yet
      }
    } catch (e) {
      if (!isNetworkError(e)) throw e
      const cached = await messageCache.load(key)
      if (targetRef.current.currentUri !== entity.entityUri) return
      setThread({ entity, key, existingTopic: null })
      dispatch({ type: 'history', messages: cached ?? [] })
      setOffline(true)
    }
  }

  async function loadHistory(topic: string, forUri: string, key: string) {
    const client = clientRef.current
    const creds = credsRef.current
    if (!client || !creds) return
    try {
      const fetched = await client.getMessages(creds.channelName, topic)
      if (targetRef.current.currentUri !== forUri) return
      dispatch({ type: 'history', messages: fetched })
      setOffline(false)
      void messageCache.save(key, fetched)
    } catch (e) {
      if (!isNetworkError(e)) throw e // 429/403/etc keep the existing error path
      const cached = await messageCache.load(key)
      if (targetRef.current.currentUri !== forUri) return
      dispatch({ type: 'history', messages: cached ?? [] })
      setOffline(true)
    }
  }

  function refreshCurrentThread() {
    const t = threadRef.current
    if (!t) return
    if (t.existingTopic) loadHistory(t.existingTopic, t.entity.entityUri, t.key).catch(() => {})
    else void initThread(t.entity).catch(() => {}) // opened offline / not yet resolved — re-resolve
  }

  async function send(text: string) {
    const t = threadRef.current
    const client = clientRef.current
    const creds = credsRef.current
    if (!t || !client || !creds) return
    if (sendingRef.current) return // backlog #3: synchronous latch
    sendingRef.current = true
    setSending(true)
    setError(null)
    try {
      let topic = t.existingTopic
      if (!topic) {
        topic = topicName(t.entity.title, t.key)
        try {
          await client.sendMessage(creds.channelName, topic, headerMessage(t.entity, creds.email))
        } catch {
          await client.sendMessage(creds.channelName, topic, headerMessage(t.entity, creds.email)).catch(() => {})
        }
        setThread({ ...t, existingTopic: topic })
        const resolved: RuntimeToSw = { type: 'topicResolved', topicKey: t.key, topicName: topic }
        void browser.runtime.sendMessage(resolved).catch(() => {})
      }
      await client.sendMessage(creds.channelName, topic, text)
      drafts.clear(t.entity.entityUri)
      if (targetRef.current.currentUri === t.entity.entityUri) setDraftText('')
      await loadHistory(topic, t.entity.entityUri, t.key)
    } catch (e) {
      setError(errText(e))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  async function startEdit(id: number) {
    const client = clientRef.current
    if (!client) return
    setActionBusy(true)
    try {
      const raw = await client.getRawMessage(id)
      if (clientRef.current !== client) return
      setEditState({ id, raw })
    } catch (e) {
      if (clientRef.current !== client) return
      setError(errText(e))
    } finally {
      if (clientRef.current === client) setActionBusy(false)
    }
  }

  async function saveEdit(id: number, content: string) {
    const client = clientRef.current
    if (!client) return
    setActionBusy(true)
    try {
      await client.updateMessage(id, content)
      if (clientRef.current !== client) return
      setEditState(null) // rendered update arrives via the update_message event
    } catch (e) {
      if (clientRef.current !== client) return
      setError(errText(e))
    } finally {
      if (clientRef.current === client) setActionBusy(false)
    }
  }

  async function deleteMessage(id: number) {
    const client = clientRef.current
    if (!client) return
    setActionBusy(true)
    try {
      await client.deleteMessage(id)
    } catch (e) {
      if (clientRef.current !== client) return
      setError(errText(e))
    } finally {
      if (clientRef.current === client) setActionBusy(false)
    }
  }

  async function toggleReaction(id: number, r: ReactionInput) {
    const client = clientRef.current
    if (!client || ownUserId === null) return
    const message = messages.find((m) => m.id === id)
    const mine = message?.reactions?.some(
      (x) => x.emoji_code === r.emoji_code && x.reaction_type === r.reaction_type && x.user_id === ownUserId
    )
    try {
      if (mine) await client.removeReaction(id, r.emoji_name)
      else await client.addReaction(id, r.emoji_name)
      // State updates arrive via the reaction event.
    } catch (e) {
      if (clientRef.current !== client) return
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
        <div class="header-text">
          <span class="title">{thread ? thread.entity.title : 'PageThreads'}</span>
          {thread && <span class="subtitle">{headerSubtitle(thread.entity.entityUri, messages.length)}</span>}
        </div>
        <button
          class={pinned ? 'pin pinned' : 'pin'}
          title={pinned ? 'Unpin: follow the active tab' : 'Pin: keep this thread while browsing'}
          onClick={togglePin}
        >
          📌
        </button>
        <button class="pin" title="Account" onClick={() => setShowAccount(true)}>
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
      {pendingEntity ? (
        <div class="gate">
          <div class="gate-title">{pendingEntity.title || pendingEntity.entityUri}</div>
          <button onClick={checkForDiscussion}>Check for discussion</button>
          <p class="hint">Strict privacy is on. No request is sent to your realm until you click.</p>
        </div>
      ) : (
        <ThreadView
          messages={messages}
          hasThread={!!thread?.existingTopic}
          noPage={!thread && !error}
          threadKey={thread?.key ?? null}
          ownEmail={credentials.email}
          ownUserId={ownUserId}
          realmUrl={credentials.realmUrl}
          editState={editState}
          busy={actionBusy}
          onStartEdit={(id) => void startEdit(id)}
          onCancelEdit={() => setEditState(null)}
          onSaveEdit={(id, content) => void saveEdit(id, content)}
          onDelete={(id) => void deleteMessage(id)}
          onToggleReaction={(id, r) => void toggleReaction(id, r)}
          onRendered={(ids, key) => readMarkerRef.current?.noteRendered(ids, key)}
        />
      )}
      {offline && thread && (
        <div class="offline-banner" role="status">
          Offline — showing last saved messages. Reconnect to send.
        </div>
      )}
      <Composer
        value={draftText}
        onInput={onDraftInput}
        onSend={(text) => void send(text)}
        disabled={!thread}
        busy={sending}
        offline={offline}
      />
    </div>
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

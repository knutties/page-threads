# M2b Offline Read Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each discussion readable when the realm is unreachable — cache last-fetched messages per topic in `storage.local` and, on a network-error fetch, show the cached messages for the current thread with an offline banner and a send-blocked-but-draftable composer.

**Architecture:** A pure `cacheReducer` + a serialized whole-map LRU store (`messageCache`) in `chrome.storage.local`. `isNetworkError` (a `fetch` `TypeError`) distinguishes offline from HTTP errors. `loadHistory` and `initThread` write the cache on success and fall back to it on a network error, driving an `offline` state that shows a banner and blocks send; reconnect (SW event) and `window` `online` refresh and clear it.

**Tech Stack:** TypeScript (strict), Preact, Vite, Vitest + @testing-library/preact (happy-dom for Composer, jsdom elsewhere), chrome.storage.local.

## Global Constraints

- Version bumped to **0.8.0** (`package.json` + `public/manifest.json`) — done in the final task, verbatim.
- **No new manifest permission** — LRU eviction keeps the cache within `storage.local`'s default quota; `"storage"` is already declared.
- Offline is detected ONLY by a `fetch` network failure (`isNetworkError` = `e instanceof TypeError`); a `ZulipError` (HTTP status, e.g. 429) keeps the existing error-banner path.
- Cache writes happen only on a **successful** fetch ("last-fetched" semantics); live events do not touch the cache.
- Cache cap = **50** topics (`CACHE_CAP`).
- TypeScript strict; existing tests keep passing (updated only where a signature changes, never weakened). TDD for the pure modules and the Composer prop; the App offline wiring is verified by `tsc` + build + manual acceptance.

---

### Task 1: `messageCache` module (LRU cache in storage.local)

**Files:**
- Create: `src/shared/messageCache.ts`
- Create: `src/shared/messageCache.test.ts`

**Interfaces:**
- Consumes: `ZulipMessage` (`src/shared/zulipClient.ts`), `StorageAreaLike` (`src/shared/storage.ts`).
- Produces:
  - `CACHE_CAP = 50`
  - `interface CacheEntry { messages: ZulipMessage[]; at: number }`, `type MessageCacheMap = Record<string, CacheEntry>`
  - `cacheReducer(map: MessageCacheMap, action): MessageCacheMap` with actions `{type:'put'; topicKey; messages; now; cap}` and `{type:'touch'; topicKey; now}`
  - `interface MessageCache { save(topicKey: string, messages: ZulipMessage[]): Promise<void>; load(topicKey: string): Promise<ZulipMessage[] | null> }`
  - `createMessageCache(area?: StorageAreaLike, now?: () => number): MessageCache`

- [ ] **Step 1: Write the failing tests** — `src/shared/messageCache.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import type { ZulipMessage } from './zulipClient'
import { cacheReducer, createMessageCache, CACHE_CAP, type MessageCacheMap } from './messageCache'

function msg(id: number): ZulipMessage {
  return { id, sender_full_name: 'A', sender_email: 'a@x.com', content: `<p>${id}</p>`, timestamp: id, subject: 'T · k' }
}

describe('cacheReducer', () => {
  test('put creates an entry stamped with now', () => {
    const next = cacheReducer({}, { type: 'put', topicKey: 'k1', messages: [msg(1)], now: 100, cap: 50 })
    expect(next.k1).toEqual({ messages: [msg(1)], at: 100 })
  })

  test('put over cap evicts the least-recently-used entries', () => {
    let map: MessageCacheMap = {}
    for (let i = 0; i < 3; i++) map = cacheReducer(map, { type: 'put', topicKey: `k${i}`, messages: [msg(i)], now: i, cap: 2 })
    // k0 (at:0) is the oldest → evicted; k1,k2 survive
    expect(Object.keys(map).sort()).toEqual(['k1', 'k2'])
  })

  test('touch bumps at; absent key returns the same reference', () => {
    const map: MessageCacheMap = { k1: { messages: [msg(1)], at: 1 } }
    const bumped = cacheReducer(map, { type: 'touch', topicKey: 'k1', now: 9 })
    expect(bumped.k1.at).toBe(9)
    expect(cacheReducer(map, { type: 'touch', topicKey: 'nope', now: 9 })).toBe(map)
  })
})

function fakeArea(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial }
  return {
    store,
    get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(store, items)
    },
  }
}

describe('createMessageCache', () => {
  test('save then load round-trips the messages', async () => {
    const area = fakeArea()
    const cache = createMessageCache(area)
    await cache.save('k1', [msg(1), msg(2)])
    expect(await cache.load('k1')).toEqual([msg(1), msg(2)])
    expect(await cache.load('missing')).toBeNull()
  })

  test('saving past the cap evicts the least-recently-used topic', async () => {
    let t = 0
    const area = fakeArea()
    const cache = createMessageCache(area, () => t++)
    for (let i = 0; i <= CACHE_CAP; i++) await cache.save(`k${i}`, [msg(i)]) // CACHE_CAP+1 topics
    expect(await cache.load('k0')).toBeNull() // oldest evicted
    expect(await cache.load(`k${CACHE_CAP}`)).toEqual([msg(CACHE_CAP)]) // newest survives
  })

  test('a QUOTA_BYTES write error triggers aggressive eviction and a retry', async () => {
    const area = fakeArea()
    let failed = false
    const realSet = area.set
    area.set = async (items: Record<string, unknown>) => {
      if (!failed) {
        failed = true
        throw new Error('QUOTA_BYTES quota exceeded')
      }
      return realSet(items)
    }
    const cache = createMessageCache(area)
    await cache.save('k1', [msg(1)]) // first set throws, retry succeeds
    expect(failed).toBe(true)
    expect(await cache.load('k1')).toEqual([msg(1)])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/shared/messageCache.test.ts`
Expected: FAIL — cannot resolve `./messageCache`.

- [ ] **Step 3: Implement** — `src/shared/messageCache.ts`

```ts
import type { StorageAreaLike } from './storage'
import type { ZulipMessage } from './zulipClient'

export const CACHE_CAP = 50
const KEY = 'msgCache'

export interface CacheEntry {
  messages: ZulipMessage[]
  at: number // last-access epoch ms (LRU)
}
export type MessageCacheMap = Record<string, CacheEntry>

export type CacheAction =
  | { type: 'put'; topicKey: string; messages: ZulipMessage[]; now: number; cap: number }
  | { type: 'touch'; topicKey: string; now: number }

function evictToCap(map: MessageCacheMap, cap: number): MessageCacheMap {
  const keys = Object.keys(map)
  if (keys.length <= cap) return map
  const ordered = keys.sort((a, b) => map[a]!.at - map[b]!.at) // oldest first
  const survivors = ordered.slice(ordered.length - cap)
  const next: MessageCacheMap = {}
  for (const k of survivors) next[k] = map[k]!
  return next
}

export function cacheReducer(map: MessageCacheMap, action: CacheAction): MessageCacheMap {
  switch (action.type) {
    case 'put': {
      const next: MessageCacheMap = { ...map, [action.topicKey]: { messages: action.messages, at: action.now } }
      return evictToCap(next, action.cap)
    }
    case 'touch': {
      const entry = map[action.topicKey]
      if (!entry) return map
      return { ...map, [action.topicKey]: { ...entry, at: action.now } }
    }
  }
}

export interface MessageCache {
  save(topicKey: string, messages: ZulipMessage[]): Promise<void>
  load(topicKey: string): Promise<ZulipMessage[] | null>
}

/**
 * Per-topicKey LRU cache of last-fetched messages in storage.local. Writes are
 * serialized (whole-map read-modify-write, since createStore can't delete keys,
 * which eviction needs). Best-effort: quota failures evict harder and retry once,
 * then give up silently.
 */
export function createMessageCache(
  area: StorageAreaLike = chrome.storage.local,
  now: () => number = () => Date.now()
): MessageCache {
  let chain: Promise<unknown> = Promise.resolve()

  async function readMap(): Promise<MessageCacheMap> {
    return ((await area.get(KEY))[KEY] as MessageCacheMap | undefined) ?? {}
  }

  function serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = chain.then(op)
    chain = next.then(
      () => {},
      () => {}
    )
    return next
  }

  return {
    save(topicKey, messages) {
      return serialize(async () => {
        const map = await readMap()
        let put = cacheReducer(map, { type: 'put', topicKey, messages, now: now(), cap: CACHE_CAP })
        try {
          await area.set({ [KEY]: put })
        } catch (e) {
          if (String((e as Error)?.message ?? e).includes('QUOTA_BYTES')) {
            put = cacheReducer(put, { type: 'put', topicKey, messages, now: now(), cap: Math.floor(CACHE_CAP / 2) })
            await area.set({ [KEY]: put }).catch(() => {}) // best-effort retry
          }
          // otherwise swallow — the cache is best-effort
        }
      })
    },
    load(topicKey) {
      return serialize(async () => {
        const map = await readMap()
        const entry = map[topicKey]
        if (!entry) return null
        await area.set({ [KEY]: cacheReducer(map, { type: 'touch', topicKey, now: now() }) }).catch(() => {})
        return entry.messages
      })
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/shared/messageCache.test.ts && npx tsc --noEmit`
Expected: PASS (6 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/messageCache.ts src/shared/messageCache.test.ts
git commit -m "feat: per-topicKey LRU message cache in storage.local"
```

---

### Task 2: Composer offline prop (draft-editable, send blocked)

**Files:**
- Modify: `src/panel/Composer.tsx`
- Modify: `src/panel/Composer.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Composer` gains an optional `offline?: boolean` prop (default `false`).

- [ ] **Step 1: Add the failing test** — append inside `describe('Composer', …)` in `src/panel/Composer.test.tsx`

```ts
  test('offline keeps the textarea editable but blocks send', () => {
    const onSend = vi.fn()
    render(<Composer value="hello" onInput={() => {}} onSend={onSend} disabled={false} busy={false} offline={true} />)
    const box = screen.getByPlaceholderText('Offline — reconnect to send') as HTMLTextAreaElement
    expect(box.disabled).toBe(false)
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.submit(box.closest('form')!)
    expect(onSend).not.toHaveBeenCalled()
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(true)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/panel/Composer.test.tsx`
Expected: FAIL — `offline` prop is unknown / no such placeholder.

- [ ] **Step 3: Add the prop** — `src/panel/Composer.tsx`

Add `offline = false` to the destructured params and its type, and use it. The full component becomes:

```tsx
export function Composer({
  value,
  onInput,
  onSend,
  disabled,
  busy,
  offline = false,
}: {
  value: string
  onInput: (text: string) => void
  onSend: (text: string) => void
  disabled: boolean
  busy: boolean
  offline?: boolean
}) {
  function submit(e: Event) {
    e.preventDefault()
    if (busy || offline) return // a send is in flight, or we're offline
    const t = value.trim()
    if (!t) return
    onSend(t)
  }

  return (
    <form class="composer" onSubmit={submit}>
      <textarea
        value={value}
        onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          // isComposing guards IME input; keyCode 229 is the legacy signal some engines still use.
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) submit(e)
        }}
        placeholder={offline ? 'Offline — reconnect to send' : 'Write a message…'}
        disabled={disabled}
      />
      <button type="submit" disabled={disabled || busy || offline || !value.trim()}>
        Send
      </button>
    </form>
  )
}
```

- [ ] **Step 4: Run the Composer tests + typecheck**

Run: `npx vitest run src/panel/Composer.test.tsx && npx tsc --noEmit`
Expected: PASS — the new offline test plus all existing Composer tests (they don't pass `offline`, so the placeholder stays `Write a message…`).

- [ ] **Step 5: Commit**

```bash
git add src/panel/Composer.tsx src/panel/Composer.test.tsx
git commit -m "feat: Composer offline prop — draft-editable, send blocked"
```

---

### Task 3: `isNetworkError` + offline fallback in `loadHistory` (offline while viewing)

**Files:**
- Create: `src/shared/netError.ts`
- Create: `src/shared/netError.test.ts`
- Modify: `src/panel/App.tsx`
- Modify: `src/panel/style.css`

**Interfaces:**
- Consumes: `createMessageCache` (Task 1); `Composer` `offline` prop (Task 2); `ZulipError` (`src/shared/zulipClient.ts`).
- Produces: `isNetworkError(e: unknown): boolean`; `loadHistory(topic, forUri, key)` (now 3-arg); `refreshCurrentThread()`; an `offline` state driving a banner + the Composer.

- [ ] **Step 1: Write the failing `isNetworkError` test** — `src/shared/netError.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { isNetworkError } from './netError'
import { ZulipError } from './zulipClient'

describe('isNetworkError', () => {
  test('a fetch TypeError is a network error', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
  })
  test('a ZulipError (HTTP status) is not a network error', () => {
    expect(isNetworkError(new ZulipError('HTTP 429', 'RATE_LIMIT'))).toBe(false)
  })
  test('a plain Error is not a network error', () => {
    expect(isNetworkError(new Error('boom'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/shared/netError.test.ts`
Expected: FAIL — cannot resolve `./netError`.

- [ ] **Step 3: Implement `isNetworkError`** — `src/shared/netError.ts`

```ts
/**
 * A fetch that never reached the server rejects with TypeError (unreachable
 * realm, DNS failure, TLS/cert rejection) — distinct from ZulipError, which is
 * only thrown after an HTTP response is received.
 */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/shared/netError.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the cache + offline state into `App.tsx`**

Add imports (with the other `../shared/*` imports):

```ts
import { createMessageCache } from '../shared/messageCache'
import { isNetworkError } from '../shared/netError'
```

Add the module-level singleton next to `const drafts = new Drafts()`:

```ts
const messageCache = createMessageCache()
```

Add the offline state (next to the other `useState`s, e.g. after `const [sending, setSending] = ...`):

```ts
  const [offline, setOffline] = useState(false)
```

Replace `loadHistory` with the 3-arg, cache-backed version:

```ts
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
```

Add a `refreshCurrentThread` helper (near `loadHistory`) — for now it only handles a resolved topic (Task 4 extends it):

```ts
  function refreshCurrentThread() {
    const t = threadRef.current
    if (t?.existingTopic) loadHistory(t.existingTopic, t.entity.entityUri, t.key).catch(() => {})
  }
```

Update the two `loadHistory` call sites that already have a resolved topic in `initThread` and `send` to pass the key:
- in `initThread`, `await loadHistory(existingTopic, entity.entityUri)` → `await loadHistory(existingTopic, entity.entityUri, key)`
- in `send`, `await loadHistory(topic, t.entity.entityUri)` → `await loadHistory(topic, t.entity.entityUri, t.key)`

Replace the reconnect call sites with `refreshCurrentThread()`:
- the `msg.type === 'reconnected'` handler body (currently `const t = threadRef.current; if (t?.existingTopic) loadHistory(t.existingTopic, t.entity.entityUri).catch(() => {})`) becomes:
  ```ts
      } else if (msg.type === 'reconnected') {
        refreshCurrentThread()
      }
  ```
- inside `connect(isReconnect)`, the reconnect branch (currently `} else if (t.existingTopic) { loadHistory(t.existingTopic, t.entity.entityUri).catch(() => {}) }`) becomes:
  ```ts
      if (!isReconnect || !t) {
        port.postMessage({ type: 'getActiveEntity' } satisfies PanelToSw)
      } else {
        refreshCurrentThread()
      }
  ```

- [ ] **Step 6: Render the offline banner + pass `offline` to the Composer** — `App.tsx`

Immediately before the `<Composer …>` element, add the banner; and add the `offline` prop:

```tsx
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
```

- [ ] **Step 7: Style the banner** — append to `src/panel/style.css`

```css
.offline-banner { background: var(--pt-pill-bg); color: var(--pt-muted); padding: 6px 12px; font-size: 12px; border-top: 1px solid var(--pt-line); }
```

- [ ] **Step 8: Typecheck + build + full suite**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: no type errors; build succeeds; all tests PASS (the netError unit tests, and every existing test — the `loadHistory` signature change is internal to `App`).

- [ ] **Step 9: Commit**

```bash
git add src/shared/netError.ts src/shared/netError.test.ts src/panel/App.tsx src/panel/style.css
git commit -m "feat: offline fallback in loadHistory — show cached messages + banner + blocked send"
```

---

### Task 4: Offline thread resolution + reconnect/online refresh + version bump

**Files:**
- Modify: `src/panel/App.tsx`
- Modify: `package.json`, `public/manifest.json` (version → 0.8.0)

**Interfaces:**
- Consumes: `messageCache`, `isNetworkError`, `refreshCurrentThread`, `offline` state, `loadHistory` (Task 3); `topicKey` (`src/shared/topic.ts`, already imported in `App`).
- Produces: no new interface — `initThread` resolves from cache when offline, and `refreshCurrentThread` + a `window` `online` listener recover offline-opened threads.

- [ ] **Step 1: Make `initThread` fall back to the cache on a network error** — `src/panel/App.tsx`

Replace `initThread` with (the topicKey is derived client-side, so we can load the cache even when the realm is unreachable):

```ts
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
        void chrome.runtime.sendMessage(msg).catch(() => {})
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
```

- [ ] **Step 2: Extend `refreshCurrentThread` to re-resolve an offline-opened thread**

Replace `refreshCurrentThread` (from Task 3) with:

```ts
  function refreshCurrentThread() {
    const t = threadRef.current
    if (!t) return
    if (t.existingTopic) loadHistory(t.existingTopic, t.entity.entityUri, t.key).catch(() => {})
    else void initThread(t.entity).catch(() => {}) // opened offline / not yet resolved — re-resolve
  }
```

- [ ] **Step 3: Add a `window` `online` listener that refreshes the current thread**

Add this effect alongside the other `useEffect`s in `App` (it reads only refs, so `[]` deps are correct):

```ts
  useEffect(() => {
    const onOnline = () => refreshCurrentThread()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])
```

- [ ] **Step 4: Bump the version to 0.8.0**

In `package.json` set `"version": "0.8.0"`. In `public/manifest.json` set `"version": "0.8.0"`.

- [ ] **Step 5: Typecheck + build + full suite**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: no type errors; build succeeds; all tests PASS (App offline wiring is internal; no assertions touched).

- [ ] **Step 6: Commit**

```bash
git add src/panel/App.tsx package.json public/manifest.json
git commit -m "feat: resolve a thread from cache when offline; refresh on reconnect/online; v0.8.0"
```

---

## Manual Acceptance (after all tasks)

1. Open a thread online (populates the cache). Stop the realm (OrbStack down, or block the host) and switch to another tab then back / reopen that thread → the cached messages show with the offline banner, Send is disabled, and the textarea still accepts a draft.
2. Restart the realm → on reconnect (SW event or OS `online`) the thread refreshes with live data and the banner clears; the draft you typed can now be sent.
3. A thread never opened online, viewed while offline → empty thread + offline banner (nothing cached).
4. A non-network failure (e.g. force a 429) → the existing error banner, NOT the offline path.
5. Visit many (>50) distinct threaded pages, then go offline on the first one → it may be evicted (empty + banner), confirming the cache stays bounded.

## Self-Review

**1. Spec coverage:**
- Per-topicKey LRU cache in storage.local (~50), evict within default quota, no new permission → Task 1. ✓
- `isNetworkError` distinguishes fetch failure from ZulipError → Task 3. ✓
- `loadHistory` writes cache on success, falls back on network error, rethrows others → Task 3. ✓
- Offline banner + composer draft-editable/send-blocked → Task 2 (prop) + Task 3 (wiring/banner/style). ✓
- Clear offline + refresh on reconnect (SW event) and `window` online → Task 3 (`refreshCurrentThread` on reconnected) + Task 4 (online listener, offline-opened re-resolve). ✓
- Open-while-offline resolves topicKey client-side and shows cache → Task 4 (`initThread` catch). ✓
- Version 0.8.0 → Task 4 Step 4. ✓
- Non-goals honored (no SWR, live events don't touch cache, actions not specially disabled). ✓

**2. Placeholder scan:** No TBD/TODO; every step has complete code; the fake area + quota test are spelled out. ✓

**3. Type consistency:** `createMessageCache(area?, now?)` → `MessageCache { save, load }` defined in Task 1, used in Tasks 3–4. `cacheReducer`/`CACHE_CAP`/`MessageCacheMap` names consistent. `isNetworkError(e)` defined in Task 3, used in Tasks 3–4. `loadHistory(topic, forUri, key)` 3-arg signature defined in Task 3 and called consistently (initThread, send, refreshCurrentThread). `refreshCurrentThread()` introduced in Task 3, extended in Task 4. Composer `offline?: boolean` defined in Task 2, passed in Task 3. `CacheEntry.at`/`.messages` field names consistent. ✓

# PageThreads M1d-3 — Unread Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-tab unread badge on the toolbar icon, live from events while a panel is open and poll-refreshed via chrome.alarms otherwise, with Zulip as the source of truth (a rebuildable storage.session cache).

**Architecture:** A pure `unreadReducer` over a `Record<topicKey, number>` map, cached in `chrome.storage.session`. A pure `badgeText` + `keyFromTopicName`. `ZulipClient.getUnreadCount` counts via an `is:unread` narrow. A fully-injectable `badgeManager` owns the in-memory map + active-tab tracking and the increment/zero/refresh orchestration (chrome injected, so it's unit-tested like M1c's `lifecycle.ts`). The SW resolves the active tab's topic itself (cached streamId/topics) on activation and the ~2-min alarm; the panel sends `markedRead`/`topicResolved` for instant updates.

**Tech Stack:** Existing — TypeScript strict, Vite, Preact, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-14-m1d3-unread-badge-design.md`.

## Global Constraints

- Unread map lives in `chrome.storage.session` (rebuildable; survives SW restart within a session, clears on browser close). No new storage permission (`"storage"` covers session).
- Own messages never increment (`message.sender_email === credentials.email`); `is:unread` naturally excludes them on recompute.
- Badge per §6.4: unread number (capped `99+`) when `>0`; `•` when a thread exists with 0 unread; `''` when no thread / no-page / blocked.
- Per-tab via `chrome.action.setBadgeText({ tabId, text })`; clear on `tabs.onRemoved`.
- `"alarms"` permission added; `chrome.alarms.create('badge', { periodInMinutes: 2 })`. (Manifest permission change ⇒ full browser relaunch — README already documents this.)
- `src/shared/*` keeps chrome APIs only as default parameter values.
- Version `0.6.0` in `package.json` + `public/manifest.json` (Task 7). Existing 231 tests keep passing. **This chunk completes M1.**
- Branch `m1d3-unread-badge` off main. Commit trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LpgtuXYp32egiB82M3qkAb`

---

### Task 1: Unread store + reducer (`shared/unread.ts`)

**Files:**
- Create: `src/shared/unread.ts`
- Test: `src/shared/unread.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 4/5):

```ts
type UnreadMap = Record<string, number>
type UnreadAction = { type: 'increment'; topicKey: string } | { type: 'set'; topicKey: string; count: number } | { type: 'zero'; topicKey: string }
function unreadReducer(map: UnreadMap, action: UnreadAction): UnreadMap
function createUnreadStore(area?, changed?, areaName?): Store<UnreadMap>   // defaults chrome.storage.session / 'session'
```

- [ ] **Step 1: Write the failing tests**

`src/shared/unread.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { createUnreadStore, unreadReducer, type UnreadMap } from './unread'
import type { ChangeListener } from './storage'

describe('unreadReducer', () => {
  test('increment creates a topic at 1, then adds', () => {
    let m: UnreadMap = {}
    m = unreadReducer(m, { type: 'increment', topicKey: 'k' })
    expect(m).toEqual({ k: 1 })
    m = unreadReducer(m, { type: 'increment', topicKey: 'k' })
    expect(m).toEqual({ k: 2 })
  })

  test('set overwrites', () => {
    expect(unreadReducer({ k: 5 }, { type: 'set', topicKey: 'k', count: 2 })).toEqual({ k: 2 })
  })

  test('zero sets 0', () => {
    expect(unreadReducer({ k: 5 }, { type: 'zero', topicKey: 'k' })).toEqual({ k: 0 })
  })

  test('zero on an already-0 topic returns the SAME reference (no-op)', () => {
    const m = { k: 0 }
    expect(unreadReducer(m, { type: 'zero', topicKey: 'k' })).toBe(m)
  })

  test('zero on an absent topic returns the SAME reference (no-op)', () => {
    const m = { k: 1 }
    expect(unreadReducer(m, { type: 'zero', topicKey: 'other' })).toBe(m)
  })

  test('set to the same value returns the SAME reference', () => {
    const m = { k: 3 }
    expect(unreadReducer(m, { type: 'set', topicKey: 'k', count: 3 })).toBe(m)
  })

  test('does not mutate the input', () => {
    const m = { k: 1 }
    unreadReducer(m, { type: 'increment', topicKey: 'k' })
    expect(m).toEqual({ k: 1 })
  })
})

describe('createUnreadStore', () => {
  function fakeStorage() {
    const data: Record<string, unknown> = {}
    const listeners = new Set<ChangeListener>()
    return {
      area: {
        get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(data, items)
          for (const l of listeners) {
            l(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])), 'session')
          }
        },
      },
      changed: {
        addListener: (l: ChangeListener) => listeners.add(l),
        removeListener: (l: ChangeListener) => listeners.delete(l),
      },
    }
  }

  test('defaults to an empty map and round-trips', async () => {
    const { area, changed } = fakeStorage()
    const store = createUnreadStore(area, changed, 'session')
    expect(await store.load()).toEqual({})
    await store.save({ k: 3 })
    expect(await store.load()).toEqual({ k: 3 })
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/shared/unread.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/shared/unread.ts`:

```ts
import { createStore, type StorageAreaLike, type StorageChangedLike, type Store } from './storage'

export type UnreadMap = Record<string, number>

export type UnreadAction =
  | { type: 'increment'; topicKey: string }
  | { type: 'set'; topicKey: string; count: number }
  | { type: 'zero'; topicKey: string }

export function unreadReducer(map: UnreadMap, action: UnreadAction): UnreadMap {
  switch (action.type) {
    case 'increment':
      return { ...map, [action.topicKey]: (map[action.topicKey] ?? 0) + 1 }
    case 'set':
      if (map[action.topicKey] === action.count) return map
      return { ...map, [action.topicKey]: action.count }
    case 'zero':
      if ((map[action.topicKey] ?? 0) === 0) return map
      return { ...map, [action.topicKey]: 0 }
  }
}

/** Per-topicKey unread counts, cached in chrome.storage.session (rebuildable). */
export function createUnreadStore(
  area: StorageAreaLike = chrome.storage.session,
  changed: StorageChangedLike = chrome.storage.onChanged,
  areaName = 'session'
): Store<UnreadMap> {
  return createStore('unread', {}, area, changed, areaName)
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/shared/unread.test.ts && npx tsc --noEmit`
Expected: PASS (8 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/unread.ts src/shared/unread.test.ts
git commit -m "feat: unread map reducer and storage.session cache"
```

---

### Task 2: getUnreadCount (`zulipClient.ts`)

**Files:**
- Modify: `src/shared/zulipClient.ts`
- Modify: `src/shared/zulipClient.test.ts` (append)

**Interfaces:**
- Produces (consumed by Task 5): `client.getUnreadCount(channel: string, topic: string): Promise<number>`

- [ ] **Step 1: Append the failing test**

Append to `src/shared/zulipClient.test.ts` (inside the existing `describe('message features endpoints', …)` or a new describe — the `cfg` const and fake-fetch pattern already exist at the top of the file):

```ts
describe('unread count', () => {
  test('getUnreadCount narrows on channel+topic+is:unread and returns the message count', async () => {
    const calls: Array<{ url: string }> = []
    const fn = (async (url: any) => {
      calls.push({ url: String(url) })
      return new Response(JSON.stringify({ result: 'success', messages: [{ id: 1 }, { id: 2 }, { id: 3 }] }))
    }) as typeof fetch
    const n = await new ZulipClient(cfg, fn).getUnreadCount('web-threads', 'T · k')
    expect(n).toBe(3)
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/v1/messages')
    expect(url.searchParams.get('anchor')).toBe('newest')
    expect(url.searchParams.get('num_after')).toBe('0')
    expect(JSON.parse(url.searchParams.get('narrow')!)).toEqual([
      { operator: 'channel', operand: 'web-threads' },
      { operator: 'topic', operand: 'T · k' },
      { operator: 'is', operand: 'unread' },
    ])
  })

  test('getUnreadCount returns 0 for an empty result', async () => {
    const fn = (async () => new Response(JSON.stringify({ result: 'success', messages: [] }))) as typeof fetch
    expect(await new ZulipClient(cfg, fn).getUnreadCount('web-threads', 'T · k')).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/shared/zulipClient.test.ts`
Expected: the 2 new tests FAIL (method missing).

- [ ] **Step 3: Implement**

In `src/shared/zulipClient.ts`, add the method alongside `getMessages` (uses the existing `request` + `GetMessagesResponse` shape):

```ts
  async getUnreadCount(channel: string, topic: string): Promise<number> {
    const data = await this.request<GetMessagesResponse>('GET', '/messages', {
      anchor: 'newest',
      num_before: 1000,
      num_after: 0,
      apply_markdown: false,
      narrow: [
        { operator: 'channel', operand: channel },
        { operator: 'topic', operand: topic },
        { operator: 'is', operand: 'unread' },
      ],
    })
    return data.messages.length
  }
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/shared/zulipClient.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/zulipClient.ts src/shared/zulipClient.test.ts
git commit -m "feat: getUnreadCount via is:unread narrow"
```

---

### Task 3: Badge text + topic-key extraction (`shared/badge.ts`)

**Files:**
- Create: `src/shared/badge.ts`
- Test: `src/shared/badge.test.ts`

**Interfaces:**
- Produces (consumed by Task 4): `badgeText(unread: number, hasThread: boolean): string`; `keyFromTopicName(name: string): string | null`.

- [ ] **Step 1: Write the failing tests**

`src/shared/badge.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { badgeText, keyFromTopicName } from './badge'

describe('badgeText', () => {
  test('positive unread shows the number', () => {
    expect(badgeText(1, true)).toBe('1')
    expect(badgeText(42, true)).toBe('42')
  })

  test('caps at 99+', () => {
    expect(badgeText(99, true)).toBe('99')
    expect(badgeText(100, true)).toBe('99+')
    expect(badgeText(5000, true)).toBe('99+')
  })

  test('a thread with zero unread shows a dot', () => {
    expect(badgeText(0, true)).toBe('•')
  })

  test('no thread shows nothing (even if a stale count is passed)', () => {
    expect(badgeText(0, false)).toBe('')
    expect(badgeText(3, false)).toBe('')
  })
})

describe('keyFromTopicName', () => {
  test('extracts the 16-char key after the middle dot', () => {
    expect(keyFromTopicName(`My Page · ${'k'.repeat(16)}`)).toBe('k'.repeat(16))
  })

  test('extracts even when the title contains a middle dot', () => {
    expect(keyFromTopicName(`A · B · ${'x'.repeat(16)}`)).toBe('x'.repeat(16))
  })

  test('returns null when there is no key suffix', () => {
    expect(keyFromTopicName('no key here')).toBeNull()
    expect(keyFromTopicName('Title · short')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/shared/badge.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/shared/badge.ts`:

```ts
/** Toolbar badge text for a tab's topic (spec §6.4). */
export function badgeText(unread: number, hasThread: boolean): string {
  if (!hasThread) return ''
  if (unread <= 0) return '•'
  return unread > 99 ? '99+' : String(unread)
}

/**
 * The topicKey is the trailing `· <16 base64url chars>` of a topic name
 * (spec §4.6). Extract it so unread counts can be keyed by topicKey.
 */
export function keyFromTopicName(name: string): string | null {
  const m = name.match(/· ([A-Za-z0-9_-]{16})$/)
  return m ? m[1] : null
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/shared/badge.test.ts && npx tsc --noEmit`
Expected: PASS (7 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/badge.ts src/shared/badge.test.ts
git commit -m "feat: badge text mapping and topic-key extraction"
```

---

### Task 4: Badge manager (`background/badgeManager.ts`)

**Files:**
- Create: `src/background/badgeManager.ts`
- Test: `src/background/badgeManager.test.ts`

**Interfaces:**
- Consumes: `unreadReducer`/`UnreadMap` (Task 1), `badgeText`/`keyFromTopicName` (Task 3).
- Produces (consumed by Task 5):

```ts
interface ResolvedTopic { topicKey: string; topicName: string | null }  // topicName null → resolvable entity, thread not created yet
function createBadgeManager(deps: {
  resolveTopic(entityUri: string): Promise<ResolvedTopic | null>   // null → not resolvable (no creds/error)
  computeCount(topicName: string): Promise<number>
  setBadge(tabId: number, text: string): void
  onChange(map: UnreadMap): void                                    // persist to storage.session
}): {
  seed(map: UnreadMap): void
  setActiveTab(tabId: number | null): void
  refreshTab(tabId: number, entityUri: string | null): Promise<void>
  onMessageEvent(topicName: string, senderIsSelf: boolean): void
  onMarkedRead(topicKey: string): void
}
```

- [ ] **Step 1: Write the failing tests**

`src/background/badgeManager.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest'
import { createBadgeManager } from './badgeManager'

function setup(over: Partial<Parameters<typeof createBadgeManager>[0]> = {}) {
  const badges: Array<[number, string]> = []
  const persisted: Array<Record<string, number>> = []
  const mgr = createBadgeManager({
    resolveTopic: async (uri) => ({ topicKey: uri.slice(-16).padStart(16, 'k'), topicName: `T · ${uri.slice(-16).padStart(16, 'k')}` }),
    computeCount: async () => 0,
    setBadge: (tabId, text) => badges.push([tabId, text]),
    onChange: (m) => persisted.push({ ...m }),
    ...over,
  })
  return { mgr, badges, persisted }
}

const KEY = 'k'.repeat(16)
const NAME = `T · ${KEY}`

describe('badgeManager.refreshTab', () => {
  test('null entity clears the badge', async () => {
    const { mgr, badges } = setup()
    await mgr.refreshTab(7, null)
    expect(badges).toEqual([[7, '']])
  })

  test('resolvable entity with no thread yet → empty badge', async () => {
    const { mgr, badges } = setup({ resolveTopic: async () => ({ topicKey: KEY, topicName: null }) })
    await mgr.refreshTab(7, 'web:x')
    expect(badges).toEqual([[7, '']])
  })

  test('resolved thread with unread count → number badge and cached', async () => {
    const { mgr, badges, persisted } = setup({
      resolveTopic: async () => ({ topicKey: KEY, topicName: NAME }),
      computeCount: async () => 4,
    })
    await mgr.refreshTab(7, 'web:x')
    expect(badges).toEqual([[7, '4']])
    expect(persisted.at(-1)).toEqual({ [KEY]: 4 })
  })

  test('resolved thread with zero unread → dot', async () => {
    const { mgr, badges } = setup({
      resolveTopic: async () => ({ topicKey: KEY, topicName: NAME }),
      computeCount: async () => 0,
    })
    await mgr.refreshTab(7, 'web:x')
    expect(badges).toEqual([[7, '•']])
  })

  test('unresolvable (null) → empty badge', async () => {
    const { mgr, badges } = setup({ resolveTopic: async () => null })
    await mgr.refreshTab(7, 'web:x')
    expect(badges).toEqual([[7, '']])
  })
})

describe('badgeManager events', () => {
  test('onMessageEvent increments the topic and repaints the active tab from cache', () => {
    const { mgr, badges, persisted } = setup()
    mgr.setActiveTab(7)
    // active tab is showing NAME's topic
    mgr.seedActiveTopic?.(KEY, NAME) // if not present, the manager tracks the active topic via the last refreshTab; see note
    mgr.onMessageEvent(NAME, false)
    expect(persisted.at(-1)![KEY]).toBe(1)
  })

  test('onMessageEvent from self does not increment', () => {
    const { mgr, persisted } = setup()
    mgr.onMessageEvent(NAME, true)
    expect(persisted).toEqual([])
  })

  test('onMessageEvent for a name with no key suffix is ignored', () => {
    const { mgr, persisted } = setup()
    mgr.onMessageEvent('no key', false)
    expect(persisted).toEqual([])
  })

  test('onMarkedRead zeroes the topic', () => {
    const { mgr, persisted } = setup()
    mgr.onMessageEvent(NAME, false)
    mgr.onMarkedRead(KEY)
    expect(persisted.at(-1)![KEY]).toBe(0)
  })

  test('seed restores a prior map so a later increment builds on it', () => {
    const { mgr, persisted } = setup()
    mgr.seed({ [KEY]: 5 })
    mgr.onMessageEvent(NAME, false)
    expect(persisted.at(-1)![KEY]).toBe(6)
  })
})
```

Note on `seedActiveTopic`: the manager tracks the active tab's `{tabId, topicKey}` from the most recent `refreshTab`/`setActiveTab`; the repaint-from-cache test above only asserts the increment persisted (the badge repaint on the active tab is glue verified in Task 5's manual checklist). Implement without a `seedActiveTopic` method — remove that line by having the increment test assert only persistence (adjust the test to drop the `seedActiveTopic?.(…)` line; it is illustrative). Keep the assertion `expect(persisted.at(-1)![KEY]).toBe(1)`.

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/background/badgeManager.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/background/badgeManager.ts`:

```ts
import { badgeText, keyFromTopicName } from '../shared/badge'
import { unreadReducer, type UnreadMap } from '../shared/unread'

export interface ResolvedTopic {
  topicKey: string
  /** null = the entity resolves but no Zulip topic exists yet (no thread). */
  topicName: string | null
}

export function createBadgeManager(deps: {
  resolveTopic(entityUri: string): Promise<ResolvedTopic | null>
  computeCount(topicName: string): Promise<number>
  setBadge(tabId: number, text: string): void
  onChange(map: UnreadMap): void
}) {
  let map: UnreadMap = {}
  let activeTabId: number | null = null
  let activeTopicKey: string | null = null

  function mutate(action: Parameters<typeof unreadReducer>[1]): void {
    const next = unreadReducer(map, action)
    if (next !== map) {
      map = next
      deps.onChange(map)
      // Repaint the active tab from cache (no network) if it owns this topic.
      const key = 'topicKey' in action ? action.topicKey : null
      if (activeTabId != null && key != null && key === activeTopicKey) {
        deps.setBadge(activeTabId, badgeText(map[key] ?? 0, true))
      }
    }
  }

  return {
    seed(initial: UnreadMap): void {
      map = { ...initial }
    },
    setActiveTab(tabId: number | null): void {
      activeTabId = tabId
      if (tabId == null) activeTopicKey = null
    },
    async refreshTab(tabId: number, entityUri: string | null): Promise<void> {
      if (entityUri == null) {
        if (tabId === activeTabId) activeTopicKey = null
        deps.setBadge(tabId, '')
        return
      }
      const resolved = await deps.resolveTopic(entityUri)
      if (!resolved) {
        deps.setBadge(tabId, '')
        return
      }
      if (tabId === activeTabId) activeTopicKey = resolved.topicKey
      if (resolved.topicName == null) {
        deps.setBadge(tabId, '') // resolvable entity, no thread yet
        return
      }
      const count = await deps.computeCount(resolved.topicName)
      map = unreadReducer(map, { type: 'set', topicKey: resolved.topicKey, count })
      deps.onChange(map)
      deps.setBadge(tabId, badgeText(count, true))
    },
    onMessageEvent(topicName: string, senderIsSelf: boolean): void {
      if (senderIsSelf) return
      const key = keyFromTopicName(topicName)
      if (!key) return
      mutate({ type: 'increment', topicKey: key })
    },
    onMarkedRead(topicKey: string): void {
      mutate({ type: 'zero', topicKey })
    },
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/background/badgeManager.test.ts && npx tsc --noEmit`
Expected: PASS (10 tests). (Ensure the increment test asserts only `persisted.at(-1)![KEY]` per the Step-1 note — no `seedActiveTopic`.)

- [ ] **Step 5: Commit**

```bash
git add src/background/badgeManager.ts src/background/badgeManager.test.ts
git commit -m "feat: injectable badge manager — increment, zero, refresh, cache"
```

---

### Task 5: Service worker wiring + manifest

**Files:**
- Modify: `src/background/index.ts`, `src/shared/messages.ts`, `public/manifest.json`

**Interfaces:**
- Consumes: `createUnreadStore` (T1), `getUnreadCount` (T2), `topicKey`/`matchTopicByKey`/`topicName` (existing), `createBadgeManager`/`ResolvedTopic` (T4).
- Produces: `RuntimeToSw` gains `{type:'markedRead'; topicKey: string}` and `{type:'topicResolved'; tabId: number; topicKey: string; topicName: string}` (Task 6 sends these).

- [ ] **Step 1: Extend the message protocol**

In `src/shared/messages.ts`, extend `RuntimeToSw`:

```ts
export type RuntimeToSw =
  | ContentToSw
  | { type: 'credentialsChanged' }
  | { type: 'markedRead'; topicKey: string }
  | { type: 'topicResolved'; topicKey: string; topicName: string }
```

- [ ] **Step 2: Wire the badge into the service worker**

In `src/background/index.ts`:

1. Add imports:

```ts
import { createUnreadStore } from '../shared/unread'
import { matchTopicByKey, topicKey as deriveTopicKey } from '../shared/topic'
import { createBadgeManager, type ResolvedTopic } from './badgeManager'
import type { Credentials } from '../shared/credentials'
```

2. After the existing `credentialsStore`/`lifecycle` setup, add a credentials mirror + badge plumbing. Place after `credentialsStore.watch((c) => lifecycle.setCredentials(c))`:

```ts
// Badge plumbing. Credentials mirror (the lifecycle owns its own copy privately;
// the badge needs a client too). streamId/topics are cached to bound realm chatter.
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
```

3. In the lifecycle `makeLoop`'s `onEvent`, in the existing `event.type === 'message'` branch, add a badge increment alongside the broadcast (use the loop's `creds` for the self check):

```ts
        if (event.type === 'message' && event.message) {
          broadcast({ type: 'newMessage', topic: event.message.subject, message: event.message })
          badge.onMessageEvent(event.message.subject, event.message.sender_email === creds.email)
        } else if (...) {
```

(`badge` is defined below `makeLoop` at module scope but is referenced only at event time, which is always after module init — a normal forward reference within the module closure; TypeScript/JS hoist the `const badge` binding into scope. If the linter complains about use-before-declaration, move the `badge` definition above the `lifecycle` definition — it has no dependency on `lifecycle`.)

4. In the `chrome.runtime.onMessage` listener, add branches for the two new messages:

```ts
  } else if (msg.type === 'markedRead') {
    badge.onMarkedRead(msg.topicKey)
  } else if (msg.type === 'topicResolved' && sender.tab?.id != null) {
    // Instant badge for the tab whose panel just resolved a thread.
    void badge.refreshTab(sender.tab.id, /* re-resolve via entity */ tabEntities.get(sender.tab.id)?.entityUri ?? null)
  }
```

5. Update `chrome.tabs.onActivated` to also refresh the badge (it currently only calls `pushActiveEntity`):

```ts
chrome.tabs.onActivated.addListener(() => {
  void pushActiveEntity()
  void refreshActiveTabBadge()
})
```

6. In `chrome.tabs.onRemoved`, clear that tab's badge (best-effort; keep the existing tabEntities cleanup):

```ts
chrome.tabs.onRemoved.addListener((tabId) => {
  tabEntities.delete(tabId)
  void pushActiveEntity()
  void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
})
```

- [ ] **Step 3: Manifest — alarms permission**

In `public/manifest.json`, change `permissions` to include `"alarms"`:

```json
  "permissions": ["sidePanel", "storage", "alarms"],
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all green (no new unit tests here — glue over Task 4's tested manager; `dist/manifest.json` shows the alarms permission).

- [ ] **Step 5: Commit**

```bash
git add src/background/index.ts src/shared/messages.ts public/manifest.json
git commit -m "feat: service worker badge — alarms poll, activation refresh, event increment"
```

---

### Task 6: Panel notifies the SW (markedRead + topicResolved)

**Files:**
- Modify: `src/panel/App.tsx`

**Interfaces:**
- Consumes: `RuntimeToSw` `markedRead`/`topicResolved` (Task 5).

- [ ] **Step 1: Send markedRead when the read-marker flushes**

In `src/panel/App.tsx`, the read marker is created in `applyCredentials` via `createReadMarker({ flush: (ids) => clientRef.current?.markRead(ids) ?? Promise.resolve(), … })`. Wrap the flush so that, after a successful markRead, the SW is told to zero the current thread's badge:

```ts
      ? createReadMarker({
          flush: async (ids) => {
            await (clientRef.current?.markRead(ids) ?? Promise.resolve())
            const t = threadRef.current
            if (t) {
              const msg: RuntimeToSw = { type: 'markedRead', topicKey: t.key }
              void chrome.runtime.sendMessage(msg).catch(() => {})
            }
          },
          isVisible: () => document.visibilityState === 'visible',
        })
```

- [ ] **Step 2: Send topicResolved when a thread resolves**

In `initThread`, after `setThread({ entity, key, existingTopic })` when `existingTopic` is non-null, notify the SW so it can badge this tab instantly:

```ts
    setThread({ entity, key, existingTopic })
    if (existingTopic) {
      const msg: RuntimeToSw = { type: 'topicResolved', topicKey: key, topicName: existingTopic }
      void chrome.runtime.sendMessage(msg).catch(() => {})
      await loadHistory(existingTopic, entity.entityUri)
    }
```

(`RuntimeToSw` is already imported in App.tsx from the M1b work; if not, add it to the existing `../shared/messages` import.)

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/panel/App.tsx
git commit -m "feat: panel notifies SW on read-mark and thread resolution for instant badge"
```

---

### Task 7: Docs, version 0.6.0, checklist — M1 complete

**Files:**
- Modify: `package.json`, `public/manifest.json`, `README.md`

- [ ] **Step 1: Version + docs**

1. `package.json` + `public/manifest.json`: `"version": "0.6.0"`.
2. `README.md` "Current state" line → `**M1d-3 / M1 complete** (unread badge; live + polled; see docs/superpowers/specs/).`
3. `README.md` — after the M1d-2 checklist add:

```markdown
## M1d-3 acceptance checklist

- [ ] Background a page's tab (open its panel once so a thread exists), post to its topic from the Zulip web UI → the toolbar badge shows the unread count within ~2 min (instantly if a panel is open).
- [ ] Open the panel and read the thread → the badge drops to `•`.
- [ ] A page with no discussion shows no badge; a blocked domain shows no badge.
- [ ] Your own message posted from the panel does not increment the badge.
- [ ] Two tabs with different unread each show their own badge when active.
- [ ] Idle the service worker (chrome://extensions shows it inactive after ~30s), then click the tab → the badge recomputes from Zulip (survives SW restart).
- [ ] Badge count caps at `99+`.
```

- [ ] **Step 2: Verify and commit**

Run: `npm run build && npm test && npx tsc --noEmit` — all green.

```bash
git add package.json public/manifest.json README.md
git commit -m "docs: M1d-3 acceptance checklist; version 0.6.0 — M1 complete"
```

---

## Plan self-review notes

- **Spec coverage:** unread store + reducer (T1), getUnreadCount (T2), badgeText + keyFromTopicName (T3), badgeManager orchestration (T4), SW wiring — alarms/activation/event increment/markedRead/topicResolved/onRemoved/manifest (T5), panel notifications (T6), docs/version (T7). All spec sections placed.
- **Enrichment over spec (flagged):** the spec's §Service-worker wiring said the SW could rely on the panel's `topicResolved` for the topic name; this plan has the SW **independently resolve the active tab's topic** (cached streamId/topics + matchTopicByKey) on activation and the alarm, so a tab whose panel was never opened still gets a badge when activated — matching §3.2's "narrow on the active tab's topic" and making the feature actually useful. `topicResolved` remains as an instant-update optimization. This is a deliberate, documented enrichment, not a deviation to hide.
- **Type consistency:** `UnreadMap`/`unreadReducer` (T1) used in T4/T5; `getUnreadCount` (T2) called by T5's computeCount; `badgeText`/`keyFromTopicName` (T3) used in T4; `ResolvedTopic`/badgeManager API (T4) matched by T5's deps; `RuntimeToSw` additions (T5) sent by T6.
- **storage.session** needs no new permission (covered by `"storage"`); only `"alarms"` is added. Confirmed the badge (`chrome.action`) needs no permission (the `action` key already exists in the manifest).
- **Realm chatter bound:** streamId cached indefinitely (per realm), topics cached 60s (spec §5 "cache aggressively"), so an alarm wake is ~1 (getUnreadCount) + occasionally getTopics; activation is the same. Acceptable per §3.2.

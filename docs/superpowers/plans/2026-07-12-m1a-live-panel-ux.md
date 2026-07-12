# PageThreads M1a — Live Panel UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The panel follows the active tab (including SPA navigation) with a pin toggle, auto-scroll, per-thread drafts, a configurable non-web-page behavior, and the M0 review carry-forward fixes.

**Architecture:** The service worker becomes the single source of "what should the panel show": it re-evaluates the active tab's entity on tab switches, content-script reports, and tab closes, and pushes `activeEntity` to panel ports when it changes. The content script gains SPA-navigation detection (debounced, dedupe-by-entityUri). The panel routes all pushes through a pure `panelTarget` reducer (pin/unpin/hold/clear semantics) and gains drafts, auto-scroll, retry, and a typed settings layer over `chrome.storage.local`.

**Tech Stack:** Existing M0 stack — TypeScript strict, Vite, Preact, Vitest (+ @testing-library/preact, happy-dom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-12-m1a-live-panel-ux-design.md`.

## Global Constraints

- `src/shared/*` stays free of hard chrome-API references at module top level; chrome objects may appear only as *default parameter values* so tests inject fakes (pattern in Task 1).
- Content script does NO DOM writes to the host page; SPA detection is read-only listeners/observers.
- `onNonWebPage` setting: `'hold' | 'clear'`, default `'hold'` (spec).
- Debounce for nav triggers: 150 ms; fallback `location.href` poll: 500 ms; auto-scroll stick threshold: 100 px (spec).
- Existing 57 tests must keep passing after every task.
- Commit messages end with the two trailers used throughout this repo:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LpgtuXYp32egiB82M3qkAb`
- Work on branch `m1a-live-panel-ux` off `main`.

---

### Task 1: Settings foundation (`shared/settings.ts`)

**Files:**
- Create: `src/shared/settings.ts`
- Test: `src/shared/settings.test.ts`

**Interfaces:**
- Produces (consumed by Task 9's App):

```ts
interface Settings { onNonWebPage: 'hold' | 'clear' }
const DEFAULT_SETTINGS: Settings
interface SettingsStore {
  load(): Promise<Settings>
  save(patch: Partial<Settings>): Promise<void>
  watch(cb: (s: Settings) => void): () => void   // returns unsubscribe
}
function createSettingsStore(area?, changed?, areaName?): SettingsStore
```

- [ ] **Step 1: Write the failing tests**

`src/shared/settings.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { createSettingsStore, DEFAULT_SETTINGS } from './settings'

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  const listeners = new Set<ChangeListener>()
  const area = {
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items)
      for (const l of listeners) {
        l(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])), 'local')
      }
    },
  }
  const changed = {
    addListener: (l: ChangeListener) => listeners.add(l),
    removeListener: (l: ChangeListener) => listeners.delete(l),
  }
  return { area, changed, data }
}

describe('settings store', () => {
  test('load returns defaults when storage is empty', async () => {
    const { area, changed } = fakeStorage()
    const store = createSettingsStore(area, changed)
    expect(await store.load()).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.onNonWebPage).toBe('hold')
  })

  test('load merges stored partial over defaults', async () => {
    const { area, changed } = fakeStorage({ settings: { onNonWebPage: 'clear' } })
    const store = createSettingsStore(area, changed)
    expect(await store.load()).toEqual({ onNonWebPage: 'clear' })
  })

  test('save merges patch into stored settings', async () => {
    const { area, changed, data } = fakeStorage()
    const store = createSettingsStore(area, changed)
    await store.save({ onNonWebPage: 'clear' })
    expect(data.settings).toEqual({ onNonWebPage: 'clear' })
  })

  test('watch fires with merged settings on change in the right area', async () => {
    const { area, changed } = fakeStorage()
    const store = createSettingsStore(area, changed, 'local')
    const seen: unknown[] = []
    store.watch((s) => seen.push(s))
    await area.set({ settings: { onNonWebPage: 'clear' } })
    expect(seen).toEqual([{ onNonWebPage: 'clear' }])
  })

  test('watch ignores other keys and other areas; unsubscribe stops callbacks', async () => {
    const { area, changed } = fakeStorage()
    const store = createSettingsStore(area, changed, 'sync') // watching sync, events fire as local
    const seen: unknown[] = []
    const unsub = store.watch((s) => seen.push(s))
    await area.set({ settings: { onNonWebPage: 'clear' } }) // areaName 'local' ≠ 'sync'
    expect(seen).toEqual([])
    unsub()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/settings.test.ts`
Expected: FAIL — cannot resolve `./settings`.

- [ ] **Step 3: Implement**

`src/shared/settings.ts`:

```ts
export interface Settings {
  /** Panel behavior when the active tab has no web entity (chrome://, new tab). */
  onNonWebPage: 'hold' | 'clear'
}

export const DEFAULT_SETTINGS: Settings = {
  onNonWebPage: 'hold',
}

interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void

interface StorageChangedLike {
  addListener(cb: ChangeListener): void
  removeListener(cb: ChangeListener): void
}

export interface SettingsStore {
  load(): Promise<Settings>
  save(patch: Partial<Settings>): Promise<void>
  watch(cb: (settings: Settings) => void): () => void
}

const KEY = 'settings'

/** chrome.* appears only as default arguments so Node tests can inject fakes. */
export function createSettingsStore(
  area: StorageAreaLike = chrome.storage.local,
  changed: StorageChangedLike = chrome.storage.onChanged,
  areaName = 'local'
): SettingsStore {
  async function load(): Promise<Settings> {
    const stored = (await area.get(KEY))[KEY] as Partial<Settings> | undefined
    return { ...DEFAULT_SETTINGS, ...stored }
  }

  return {
    load,
    async save(patch) {
      const current = await load()
      await area.set({ [KEY]: { ...current, ...patch } })
    },
    watch(cb) {
      const listener: ChangeListener = (changes, name) => {
        if (name === areaName && changes[KEY]) {
          cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<Settings> | undefined) })
        }
      }
      changed.addListener(listener)
      return () => changed.removeListener(listener)
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/settings.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/settings.ts src/shared/settings.test.ts
git commit -m "feat: typed settings store over chrome.storage with injectable backend"
```

---

### Task 2: Panel target reducer (`panel/panelTarget.ts`)

**Files:**
- Create: `src/panel/panelTarget.ts`
- Test: `src/panel/panelTarget.test.ts`

**Interfaces:**
- Consumes: `PageEntity` from `src/shared/messages.ts`.
- Produces (consumed by Task 9's App):

```ts
interface PanelTargetState { pinned: boolean; currentUri: string | null }
type PanelTargetEvent = { type: 'push'; entity: PageEntity | null } | { type: 'pin' } | { type: 'unpin' }
type PanelTargetAction = 'ignore' | 'switch' | 'clear' | 'refresh'
interface PanelTargetResult { state: PanelTargetState; action: PanelTargetAction }
function panelTarget(state, event, onNonWebPage: 'hold' | 'clear'): PanelTargetResult
```

- [ ] **Step 1: Write the failing tests**

`src/panel/panelTarget.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { panelTarget, type PanelTargetState } from './panelTarget'

const entity = (uri: string) => ({ entityUri: uri, title: 'T' })
const s = (pinned: boolean, currentUri: string | null): PanelTargetState => ({ pinned, currentUri })

describe('panelTarget', () => {
  test('push of a new uri while unpinned → switch and track it', () => {
    const r = panelTarget(s(false, null), { type: 'push', entity: entity('web:a') }, 'hold')
    expect(r).toEqual({ state: s(false, 'web:a'), action: 'switch' })
  })

  test('push of the same uri → ignore', () => {
    const r = panelTarget(s(false, 'web:a'), { type: 'push', entity: entity('web:a') }, 'hold')
    expect(r.action).toBe('ignore')
    expect(r.state).toEqual(s(false, 'web:a'))
  })

  test('push of a different uri → switch', () => {
    const r = panelTarget(s(false, 'web:a'), { type: 'push', entity: entity('web:b') }, 'hold')
    expect(r).toEqual({ state: s(false, 'web:b'), action: 'switch' })
  })

  test('any push while pinned → ignore, state unchanged', () => {
    expect(panelTarget(s(true, 'web:a'), { type: 'push', entity: entity('web:b') }, 'hold').action).toBe('ignore')
    expect(panelTarget(s(true, 'web:a'), { type: 'push', entity: null }, 'clear').action).toBe('ignore')
  })

  test('null push while unpinned, mode hold → ignore (thread stays)', () => {
    const r = panelTarget(s(false, 'web:a'), { type: 'push', entity: null }, 'hold')
    expect(r).toEqual({ state: s(false, 'web:a'), action: 'ignore' })
  })

  test('null push while unpinned, mode clear → clear and forget uri', () => {
    const r = panelTarget(s(false, 'web:a'), { type: 'push', entity: null }, 'clear')
    expect(r).toEqual({ state: s(false, null), action: 'clear' })
  })

  test('null push when already showing nothing → ignore in both modes', () => {
    expect(panelTarget(s(false, null), { type: 'push', entity: null }, 'hold').action).toBe('ignore')
    expect(panelTarget(s(false, null), { type: 'push', entity: null }, 'clear').action).toBe('ignore')
  })

  test('pin → pinned, ignore', () => {
    expect(panelTarget(s(false, 'web:a'), { type: 'pin' }, 'hold')).toEqual({
      state: s(true, 'web:a'),
      action: 'ignore',
    })
  })

  test('unpin → unpinned, refresh (caller re-requests active entity)', () => {
    expect(panelTarget(s(true, 'web:a'), { type: 'unpin' }, 'hold')).toEqual({
      state: s(false, 'web:a'),
      action: 'refresh',
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/panel/panelTarget.test.ts`
Expected: FAIL — cannot resolve `./panelTarget`.

- [ ] **Step 3: Implement**

`src/panel/panelTarget.ts`:

```ts
import type { PageEntity } from '../shared/messages'

export interface PanelTargetState {
  pinned: boolean
  currentUri: string | null
}

export type PanelTargetEvent =
  | { type: 'push'; entity: PageEntity | null }
  | { type: 'pin' }
  | { type: 'unpin' }

export type PanelTargetAction = 'ignore' | 'switch' | 'clear' | 'refresh'

export interface PanelTargetResult {
  state: PanelTargetState
  action: PanelTargetAction
}

/** Pure decision core for follow-active-tab / pin semantics (spec §Panel). */
export function panelTarget(
  state: PanelTargetState,
  event: PanelTargetEvent,
  onNonWebPage: 'hold' | 'clear'
): PanelTargetResult {
  switch (event.type) {
    case 'pin':
      return { state: { ...state, pinned: true }, action: 'ignore' }
    case 'unpin':
      return { state: { ...state, pinned: false }, action: 'refresh' }
    case 'push': {
      if (state.pinned) return { state, action: 'ignore' }
      const uri = event.entity?.entityUri ?? null
      if (uri === null) {
        if (state.currentUri === null || onNonWebPage === 'hold') return { state, action: 'ignore' }
        return { state: { ...state, currentUri: null }, action: 'clear' }
      }
      if (uri === state.currentUri) return { state, action: 'ignore' }
      return { state: { ...state, currentUri: uri }, action: 'switch' }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/panel/panelTarget.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/panel/panelTarget.ts src/panel/panelTarget.test.ts
git commit -m "feat: pure follow/pin decision reducer for the panel"
```

---

### Task 3: Scroll and drafts helpers

**Files:**
- Create: `src/panel/scroll.ts`, `src/panel/drafts.ts`
- Test: `src/panel/scroll.test.ts`, `src/panel/drafts.test.ts`

**Interfaces:**
- Produces (consumed by Task 9):

```ts
function shouldStickToBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold?: number): boolean
class Drafts { get(uri: string): string; set(uri: string, text: string): void; clear(uri: string): void }
```

- [ ] **Step 1: Write the failing tests**

`src/panel/scroll.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { shouldStickToBottom } from './scroll'

describe('shouldStickToBottom', () => {
  test('at the exact bottom → true', () => {
    expect(shouldStickToBottom(900, 1500, 600)).toBe(true)
  })

  test('within the 100px threshold → true', () => {
    expect(shouldStickToBottom(801, 1500, 600)).toBe(true)
  })

  test('beyond the threshold (reading scrollback) → false', () => {
    expect(shouldStickToBottom(799, 1500, 600)).toBe(false)
  })

  test('content shorter than the viewport → true', () => {
    expect(shouldStickToBottom(0, 400, 600)).toBe(true)
  })

  test('custom threshold is honored', () => {
    expect(shouldStickToBottom(700, 1500, 600, 200)).toBe(true)
    expect(shouldStickToBottom(699, 1500, 600, 200)).toBe(false)
  })
})
```

`src/panel/drafts.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { Drafts } from './drafts'

describe('Drafts', () => {
  test('get returns empty string for unknown uri', () => {
    expect(new Drafts().get('web:a')).toBe('')
  })

  test('set/get round-trips per uri independently', () => {
    const d = new Drafts()
    d.set('web:a', 'hello')
    d.set('web:b', 'other')
    expect(d.get('web:a')).toBe('hello')
    expect(d.get('web:b')).toBe('other')
  })

  test('setting empty text removes the entry; clear removes it too', () => {
    const d = new Drafts()
    d.set('web:a', 'hello')
    d.set('web:a', '')
    expect(d.get('web:a')).toBe('')
    d.set('web:b', 'x')
    d.clear('web:b')
    expect(d.get('web:b')).toBe('')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/panel/scroll.test.ts src/panel/drafts.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/panel/scroll.ts`:

```ts
/** True when the view is close enough to the bottom that new messages should keep it pinned there. */
export function shouldStickToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 100
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}
```

`src/panel/drafts.ts`:

```ts
/** In-memory per-thread composer drafts, keyed by entityUri. Panel-lifetime only. */
export class Drafts {
  private map = new Map<string, string>()

  get(uri: string): string {
    return this.map.get(uri) ?? ''
  }

  set(uri: string, text: string): void {
    if (text) this.map.set(uri, text)
    else this.map.delete(uri)
  }

  clear(uri: string): void {
    this.map.delete(uri)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/panel/scroll.test.ts src/panel/drafts.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/panel/scroll.ts src/panel/scroll.test.ts src/panel/drafts.ts src/panel/drafts.test.ts
git commit -m "feat: stick-to-bottom predicate and per-thread draft store"
```

---

### Task 4: SPA navigation watcher + content-script wiring

**Files:**
- Create: `src/content/navWatcher.ts`
- Modify: `src/content/index.ts` (replace entire file)
- Test: `src/content/navWatcher.test.ts`

**Interfaces:**
- Consumes: `canonicalize` (existing), `ContentToSw` (existing).
- Produces:

```ts
function createNavWatcher(opts: { resolve: () => string; onChange: (uri: string) => void; debounceMs?: number }):
  { trigger: () => void; seed: (uri: string) => void }
```

- [ ] **Step 1: Write the failing tests**

`src/content/navWatcher.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createNavWatcher } from './navWatcher'

describe('createNavWatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('a burst of triggers resolves once after the debounce window', () => {
    const resolve = vi.fn(() => 'web:b')
    const onChange = vi.fn()
    const w = createNavWatcher({ resolve, onChange })
    w.seed('web:a')
    w.trigger()
    w.trigger()
    w.trigger()
    expect(resolve).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('web:b')
  })

  test('unchanged uri → no onChange', () => {
    const onChange = vi.fn()
    const w = createNavWatcher({ resolve: () => 'web:a', onChange })
    w.seed('web:a')
    w.trigger()
    vi.advanceTimersByTime(150)
    expect(onChange).not.toHaveBeenCalled()
  })

  test('dedupes across separate navigations (a→b→b fires once)', () => {
    let uri = 'web:b'
    const onChange = vi.fn()
    const w = createNavWatcher({ resolve: () => uri, onChange })
    w.seed('web:a')
    w.trigger()
    vi.advanceTimersByTime(150)
    w.trigger() // still web:b
    vi.advanceTimersByTime(150)
    expect(onChange).toHaveBeenCalledTimes(1)
    uri = 'web:c'
    w.trigger()
    vi.advanceTimersByTime(150)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith('web:c')
  })

  test('custom debounce window is honored', () => {
    const onChange = vi.fn()
    const w = createNavWatcher({ resolve: () => 'web:b', onChange, debounceMs: 500 })
    w.seed('web:a')
    w.trigger()
    vi.advanceTimersByTime(499)
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onChange).toHaveBeenCalledWith('web:b')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/content/navWatcher.test.ts`
Expected: FAIL — cannot resolve `./navWatcher`.

- [ ] **Step 3: Implement the watcher**

`src/content/navWatcher.ts`:

```ts
export interface NavWatcherOptions {
  /** Re-resolve the current page to an entityUri. */
  resolve: () => string
  /** Called only when the resolved uri differs from the last known one. */
  onChange: (entityUri: string) => void
  debounceMs?: number
}

/**
 * Debounces navigation signals (popstate, Navigation API, title mutations,
 * href polling) and emits only on real entity changes.
 */
export function createNavWatcher(opts: NavWatcherOptions): {
  trigger: () => void
  seed: (uri: string) => void
} {
  const debounceMs = opts.debounceMs ?? 150
  let last: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  return {
    seed(uri) {
      last = uri
    },
    trigger() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        const uri = opts.resolve()
        if (uri !== last) {
          last = uri
          opts.onChange(uri)
        }
      }, debounceMs)
    },
  }
}
```

- [ ] **Step 4: Run watcher tests to verify they pass**

Run: `npx vitest run src/content/navWatcher.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewire the content script**

`src/content/index.ts` (replace entire file):

```ts
import { canonicalize } from '../shared/canonicalize'
import type { ContentToSw } from '../shared/messages'
import { createNavWatcher } from './navWatcher'

function resolveUri(): string {
  const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  return 'web:' + canonicalize(location.href, link?.getAttribute('href') ?? null)
}

function report(entityUri: string): void {
  const msg: ContentToSw = { type: 'pageEntity', entityUri, title: document.title }
  void chrome.runtime.sendMessage(msg).catch(() => {
    // Service worker may not be listening yet (e.g. right after install); harmless.
  })
}

const initialUri = resolveUri()
report(initialUri)

const watcher = createNavWatcher({ resolve: resolveUri, onChange: report })
watcher.seed(initialUri)

window.addEventListener('popstate', () => watcher.trigger())

// SPA detection (spec §Content script): Navigation API where available,
// else title MutationObserver + 500ms location.href poll.
const navigation = (window as { navigation?: EventTarget }).navigation
if (navigation) {
  navigation.addEventListener('navigate', () => watcher.trigger())
} else {
  const title = document.querySelector('title')
  if (title) {
    new MutationObserver(() => watcher.trigger()).observe(title, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  }
  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      watcher.trigger()
    }
  }, 500)
}
```

- [ ] **Step 6: Verify build and full suite**

Run: `npm run build && npm test`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/content/navWatcher.ts src/content/navWatcher.test.ts src/content/index.ts
git commit -m "feat: SPA navigation detection with debounced entity dedupe"
```

---

### Task 5: Service worker pushes the active entity

**Files:**
- Modify: `src/background/index.ts`

**Interfaces:**
- Consumes: existing `tabEntities`, `broadcast`, `SwToPanel` `activeEntity` message (unchanged shape).
- Produces: SW behavior — on tab switch / entity report for the active tab / tab close, broadcasts `{type:'activeEntity', entity}` to all ports when the active entityUri changed since the last push. The `getActiveEntity` request/reply is unchanged.

Chrome-glue task: no unit test (composed logic is tested via Tasks 2/4); verified in Task 10's manual checklist.

- [ ] **Step 1: Implement**

In `src/background/index.ts`, add after the `broadcast` function:

```ts
let lastPushedUri: string | null | undefined // undefined = nothing pushed yet

async function pushActiveEntity(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
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
```

Change the existing `chrome.runtime.onMessage` listener to re-evaluate when the reporting tab is the active one:

```ts
chrome.runtime.onMessage.addListener((msg: ContentToSw, sender) => {
  if (msg.type === 'pageEntity' && sender.tab?.id != null) {
    tabEntities.set(sender.tab.id, { entityUri: msg.entityUri, title: msg.title })
    if (sender.tab.active) void pushActiveEntity()
  }
})
```

Change the existing `chrome.tabs.onRemoved` listener to:

```ts
chrome.tabs.onRemoved.addListener((tabId) => {
  tabEntities.delete(tabId)
  void pushActiveEntity()
})
```

Everything else in the file (ports, loop lifecycle, getActiveEntity reply, disconnect handling) stays exactly as-is.

- [ ] **Step 2: Verify build and full suite**

Run: `npm run build && npm test && npx tsc --noEmit`
Expected: all exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/background/index.ts
git commit -m "feat: service worker pushes active-tab entity changes to panel ports"
```

---

### Task 6: Composer becomes controlled + IME-safe Enter

**Files:**
- Modify: `src/panel/Composer.tsx` (replace entire file)
- Modify: `src/panel/Composer.test.tsx` (replace entire file)

**Interfaces:**
- Produces (consumed by Task 9's App): `Composer({ value, onInput, onSend, disabled })` — fully controlled; App owns the text (drafts). `onSend(trimmed)` fires on submit; App is responsible for clearing the value afterwards.

- [ ] **Step 1: Write the failing tests**

`src/panel/Composer.test.tsx` (replace entire file):

```tsx
// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact'
import { useState } from 'preact/hooks'
import { describe, expect, test, vi } from 'vitest'
import { Composer } from './Composer'

/** Harness playing the App's role: owns the value, clears it on send. */
function Harness({ onSend }: { onSend: (t: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <Composer
      value={value}
      onInput={setValue}
      onSend={(t) => {
        onSend(t)
        setValue('')
      }}
      disabled={false}
    />
  )
}

describe('Composer', () => {
  test('sends trimmed text on submit; harness clears the box', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const box = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: '  hello  ' } })
    fireEvent.submit(box.closest('form')!)
    expect(onSend).toHaveBeenCalledWith('hello')
    expect(box.value).toBe('')
  })

  test('does not send empty text', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    fireEvent.submit(screen.getByPlaceholderText('Write a message…').closest('form')!)
    expect(onSend).not.toHaveBeenCalled()
  })

  test('Enter sends, Shift+Enter does not', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const box = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: 'hi' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hi')
  })

  test('Enter during IME composition does not send', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const box = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: 'こんにちは' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  test('disabled state disables the controls', () => {
    render(<Composer value="" onInput={() => {}} onSend={() => {}} disabled={true} />)
    expect((screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement).disabled).toBe(true)
  })
})
```

Note: if happy-dom's `KeyboardEvent` drops `isComposing` from the init dict, construct the event manually in that test (`new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })` via `fireEvent(box, ev)`); document whichever was needed in the report.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/panel/Composer.test.tsx`
Expected: FAIL — Composer does not accept `value`/`onInput` props yet (type error / wrong behavior).

- [ ] **Step 3: Implement**

`src/panel/Composer.tsx` (replace entire file):

```tsx
export function Composer({
  value,
  onInput,
  onSend,
  disabled,
}: {
  value: string
  onInput: (text: string) => void
  onSend: (text: string) => void
  disabled: boolean
}) {
  function submit(e: Event) {
    e.preventDefault()
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
        placeholder="Write a message…"
        disabled={disabled}
      />
      <button type="submit" disabled={disabled || !value.trim()}>
        Send
      </button>
    </form>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/panel/Composer.test.tsx`
Expected: PASS (5 tests). Note: `src/panel/App.tsx` still uses the old props and will fail `tsc` — that is expected until Task 9; do NOT run the full build in this task. Run `npx vitest run` (all suites) instead and confirm only pre-existing App-independent suites pass.

Interim App shim so `npm test`/`tsc` stay green for reviewers: in `src/panel/App.tsx`, replace the old Composer usage

```tsx
      <Composer onSend={(text) => void send(text)} disabled={!thread} />
```

with a minimally-adapted controlled usage (full rework lands in Task 9):

```tsx
      <Composer value={draft} onInput={setDraft} onSend={(text) => { void send(text); setDraft('') }} disabled={!thread} />
```

and add alongside the other useState hooks:

```tsx
  const [draft, setDraft] = useState('')
```

- [ ] **Step 5: Verify types and full suite**

Run: `npx tsc --noEmit && npm test`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/panel/Composer.tsx src/panel/Composer.test.tsx src/panel/App.tsx
git commit -m "feat: controlled composer with IME-safe Enter handling"
```

---

### Task 7: EventLoop survives onReconnect exceptions

**Files:**
- Modify: `src/background/eventLoop.ts`
- Test: `src/background/eventLoop.test.ts` (append one test)

**Interfaces:** unchanged.

- [ ] **Step 1: Write the failing test** (append inside the existing describe block)

```ts
  test('an onReconnect exception does not kill the loop', async () => {
    let registrations = 0
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: `q${++registrations}`, lastEventId: -1 }),
      getEvents: async (queueId: string) => {
        if (queueId === 'q1') throw new ZulipError('bad', 'BAD_EVENT_QUEUE_ID')
        loop.stop()
        return []
      },
    }
    loop = new EventLoop(client, 'web-threads', {
      onEvent: () => {},
      onReconnect: () => {
        throw new Error('consumer bug')
      },
    })
    await loop.start()
    expect(registrations).toBe(2) // survived the throw and re-registered
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/background/eventLoop.test.ts`
Expected: the new test FAILS (the throw escapes `start()` and rejects).

- [ ] **Step 3: Implement**

In `src/background/eventLoop.ts`, replace the line

```ts
          this.hooks.onReconnect?.()
```

with

```ts
          try {
            this.hooks.onReconnect?.()
          } catch {
            // A consumer bug must not kill the loop (mirrors the onEvent guard).
          }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/background/eventLoop.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/background/eventLoop.ts src/background/eventLoop.test.ts
git commit -m "fix: event loop survives onReconnect exceptions"
```

---

### Task 8: Typed ZulipClient responses

**Files:**
- Modify: `src/shared/zulipClient.ts`

**Interfaces:**
- Produces: exported per-endpoint response interfaces; method signatures unchanged. No runtime behavior change — the existing 11 zulipClient tests must pass untouched.

- [ ] **Step 1: Implement**

In `src/shared/zulipClient.ts`, add below the existing `ZulipEvent` interface:

```ts
interface ZulipSuccess {
  result: 'success'
  msg: string
}

export interface GetStreamIdResponse extends ZulipSuccess {
  stream_id: number
}

export interface GetTopicsResponse extends ZulipSuccess {
  topics: Array<{ name: string; max_id: number }>
}

export interface GetMessagesResponse extends ZulipSuccess {
  messages: ZulipMessage[]
}

export interface SendMessageResponse extends ZulipSuccess {
  id: number
}

export interface RegisterResponse extends ZulipSuccess {
  queue_id: string
  last_event_id: number
}

export interface GetEventsResponse extends ZulipSuccess {
  events: ZulipEvent[]
}
```

Make `request` generic — change its signature line to:

```ts
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, unknown>
  ): Promise<T> {
```

and its final `return data` to `return data as T`.

Update each method to bind its response type (bodies otherwise unchanged):

```ts
  async getStreamId(name: string): Promise<number> {
    return (await this.request<GetStreamIdResponse>('GET', '/get_stream_id', { stream: name })).stream_id
  }

  async getTopics(streamId: number): Promise<string[]> {
    const data = await this.request<GetTopicsResponse>('GET', `/users/me/${streamId}/topics`)
    return data.topics.map((t) => t.name)
  }
```

…and likewise `request<GetMessagesResponse>`, `request<SendMessageResponse>`, `request<RegisterResponse>`, `request<GetEventsResponse>` in the remaining four methods, removing the now-unneeded `(t: { name: string })` style annotations.

- [ ] **Step 2: Verify suite and types**

Run: `npx vitest run src/shared/zulipClient.test.ts && npx tsc --noEmit && npm test`
Expected: all exit 0; zulipClient suite still 11 passing with zero test edits.

- [ ] **Step 3: Commit**

```bash
git add src/shared/zulipClient.ts
git commit -m "refactor: per-endpoint response types for ZulipClient"
```

---

### Task 9: Panel integration — follow/pin, drafts, retry, auto-scroll

**Files:**
- Modify: `src/panel/App.tsx` (replace entire file)
- Modify: `src/panel/ThreadView.tsx` (replace entire file)
- Modify: `src/panel/ThreadView.test.tsx` (replace entire file)
- Modify: `src/panel/style.css` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–6 and 8, exactly as their Produces blocks define.
- Produces: the finished M1a panel.

- [ ] **Step 1: Write the failing ThreadView tests**

`src/panel/ThreadView.test.tsx` (replace entire file):

```tsx
// @vitest-environment happy-dom
import { render, screen } from '@testing-library/preact'
import { describe, expect, test } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { ThreadView } from './ThreadView'

function msg(id: number, content: string): ZulipMessage {
  return { id, sender_full_name: 'Ada', sender_email: 'ada@x.com', content, timestamp: 1700000000, subject: 'T · k' }
}

describe('ThreadView', () => {
  test('no-page state when the active tab has no web entity', () => {
    render(<ThreadView messages={[]} hasThread={false} noPage={true} />)
    expect(screen.getByText('Open a web page to see its discussion.')).toBeTruthy()
  })

  test('shows empty state when a page is resolved but has no thread', () => {
    render(<ThreadView messages={[]} hasThread={false} noPage={false} />)
    expect(screen.getByText('No discussion yet. Start one.')).toBeTruthy()
  })

  test('renders sender and content', () => {
    render(<ThreadView messages={[msg(1, 'hello there')]} hasThread={true} noPage={false} />)
    expect(screen.getByText('Ada')).toBeTruthy()
    expect(screen.getByText('hello there')).toBeTruthy()
  })

  test('renders URLs as safe links', () => {
    render(<ThreadView messages={[msg(1, 'see https://example.com/x')]} hasThread={true} noPage={false} />)
    const a = screen.getByRole('link') as HTMLAnchorElement
    expect(a.href).toBe('https://example.com/x')
    expect(a.rel).toContain('noopener')
    expect(a.target).toBe('_blank')
  })

  test('message content is rendered as text, not HTML', () => {
    const { container } = render(
      <ThreadView messages={[msg(1, '<img src=x onerror=alert(1)>')]} hasThread={true} noPage={false} />
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/panel/ThreadView.test.tsx`
Expected: FAIL — `noPage` prop unknown / no-page text missing.

- [ ] **Step 3: Implement ThreadView**

`src/panel/ThreadView.tsx` (replace entire file):

```tsx
import { useEffect, useRef } from 'preact/hooks'
import type { ZulipMessage } from '../shared/zulipClient'
import { splitLinks } from './linkify'
import { shouldStickToBottom } from './scroll'

export function ThreadView({
  messages,
  hasThread,
  noPage,
}: {
  messages: ZulipMessage[]
  hasThread: boolean
  noPage: boolean
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const prevCount = useRef(0)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    // Thread switch (list replaced/shrunk) always jumps to bottom; live appends
    // only stick when the reader was already near the bottom.
    const replaced = prevCount.current === 0 || messages.length < prevCount.current
    if (replaced || shouldStickToBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) {
      el.scrollTop = el.scrollHeight
    }
    prevCount.current = messages.length
  }, [messages])

  if (noPage) return <div class="empty">Open a web page to see its discussion.</div>
  if (!hasThread && messages.length === 0) {
    return <div class="empty">No discussion yet. Start one.</div>
  }
  return (
    <ul class="messages" ref={listRef}>
      {messages.map((m) => (
        <li key={m.id}>
          <div class="meta">
            <span class="sender">{m.sender_full_name}</span>
            <span class="time">{new Date(m.timestamp * 1000).toLocaleString()}</span>
          </div>
          <div class="body">
            {m.content.split('\n').map((line, i) => (
              <p key={i}>
                {splitLinks(line).map((seg) =>
                  seg.kind === 'link' ? (
                    <a href={seg.value} target="_blank" rel="noopener noreferrer">
                      {seg.value}
                    </a>
                  ) : (
                    seg.value
                  )
                )}
              </p>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 4: Run ThreadView tests to verify they pass**

Run: `npx vitest run src/panel/ThreadView.test.tsx`
Expected: PASS (5 tests). (App.tsx still passes the old props; tsc breaks until Step 5 — expected mid-task.)

- [ ] **Step 5: Implement App**

`src/panel/App.tsx` (replace entire file):

```tsx
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
  const draftRef = useRef('')
  const portRef = useRef<chrome.runtime.Port | null>(null)

  function setDraft(text: string) {
    draftRef.current = text
    setDraftText(text)
  }

  function onDraftInput(text: string) {
    setDraft(text)
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
      setDraft(drafts.get(entity.entityUri))
      initThread(entity).catch((e) => setError(errText(e)))
    } else if (action === 'clear') {
      setThread(null)
      dispatch({ type: 'history', messages: [] })
      setDraft('')
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
        if (t?.existingTopic) loadHistory(t.existingTopic).catch(() => {})
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
    // A later push may have switched targets while we awaited; don't clobber it.
    if (targetRef.current.currentUri !== entity.entityUri) return
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
      drafts.clear(t.entity.entityUri)
      setDraft('')
      await loadHistory(topic)
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
```

- [ ] **Step 6: Append styles**

Append to `src/panel/style.css`:

```css
header { display: flex; align-items: center; gap: 8px; }
header .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pin { border: none; background: none; cursor: pointer; opacity: 0.35; font-size: 14px; padding: 2px; }
.pin.pinned { opacity: 1; }
.error { display: flex; align-items: center; gap: 8px; }
.error > span { flex: 1; }
.error .retry { flex: none; }
```

- [ ] **Step 7: Verify everything**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all exit 0; full suite ≥ 80 tests passing (57 pre-existing + new suites from Tasks 1–7 + updated component suites).

- [ ] **Step 8: Commit**

```bash
git add src/panel/App.tsx src/panel/ThreadView.tsx src/panel/ThreadView.test.tsx src/panel/style.css
git commit -m "feat: panel follows active tab with pin, drafts, retry, auto-scroll"
```

---

### Task 10: Docs, version bump, manual checklist

**Files:**
- Modify: `README.md`, `dev/zulip/README.md`, `package.json`, `public/manifest.json`

- [ ] **Step 1: Docs and version**

1. In `package.json` and `public/manifest.json`: `"version": "0.1.0"`.
2. In `dev/zulip/README.md`, add at the end of the intro section:

```markdown
> Note: the extension uses the `channel` narrow operator, which requires
> Zulip Server ≥ 9.0. docker-zulip's default image satisfies this.
```

3. In `README.md`, after the M0 acceptance checklist add:

```markdown
## M1a acceptance checklist

- [ ] Switching tabs updates the panel to the new tab's thread without reopening.
- [ ] In-page SPA navigation (e.g. clicking between YouTube videos) re-resolves within ~1 s.
- [ ] 📌 Pin keeps the current thread while switching tabs; unpin catches up to the active tab.
- [ ] Landing on a new-tab/chrome:// page keeps the last thread visible (default `onNonWebPage: 'hold'`).
- [ ] A half-typed message survives a tab round-trip and never leaks into another page's composer.
- [ ] While scrolled up reading history, an incoming message does NOT yank the view; at the bottom, it does scroll.
- [ ] Enter in a CJK IME composition does not send.
- [ ] When thread init fails (e.g. Zulip container stopped), the error bar shows Retry, and Retry recovers once the server is back.
```

- [ ] **Step 2: Full verification**

Run: `npm run build && npm test && npx tsc --noEmit`
Expected: all exit 0.

- [ ] **Step 3: Commit**

```bash
git add README.md dev/zulip/README.md package.json public/manifest.json
git commit -m "docs: M1a acceptance checklist; version 0.1.0"
```

---

## Plan self-review notes

- **Spec coverage:** settings foundation (T1), panelTarget incl. onNonWebPage modes (T2), auto-scroll + drafts (T3, wired T9), SPA nav w/ debounce+dedupe (T4), SW push (T5), IME guard (T6), onReconnect wrap (T7), typed client (T8), pin toggle + retry + no-page state + integration (T9), Zulip ≥ 9 note + checklist (T10). No gaps.
- **Type consistency:** `panelTarget`/`PanelTargetState` (T2) used verbatim in T9; `Composer({value, onInput, onSend, disabled})` (T6) matches T9's usage; `createSettingsStore` (T1) matches T9; `createNavWatcher` seed/trigger (T4) used only within T4's own wiring.
- **Sequencing note:** T6 keeps the repo green via an interim App shim; T9 replaces it wholesale. Reviewers of T6 should not flag the shim as final UX.

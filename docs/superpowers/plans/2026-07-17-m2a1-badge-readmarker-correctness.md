# M2a-1 SW/Badge/Read-Marker Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five confirmed M1 defects — wrong-topic read-marker badge-zero (F2), cold-start badge staleness (F3), missing focus-change badge refresh (F4), missing first-post `topicResolved` (F5a), and lingering badges after logout.

**Architecture:** Make the panel read marker topic-aware (batch by `topicKey`, report the distinct topics on flush) so badge-zeroing never reads a stale `threadRef`. Add SW badge-refresh triggers on cold-start-load-complete and window focus, a panel `topicResolved` on new-topic creation, and a `badge.reset()` + all-tabs clear on logout. No new subsystem.

**Tech Stack:** TypeScript (strict), Preact, Vite multi-entry, Vitest + @testing-library/preact + jsdom, chrome.storage / chrome.action / chrome.tabs / chrome.windows.

## Global Constraints

- Version bumped to **0.7.1** (`package.json` + `public/manifest.json`), verbatim.
- **No behavior/network/sanitize/resolver change** beyond the five listed fixes. `renderMessage.ts` (`sanitizeMessageHtml`) is untouched.
- **F5b is out of scope** — message *moves* between topics are intentionally left to the ≤2-min poll + on-activation recompute; do not add live move handling.
- TypeScript strict; all existing tests keep passing (updated only where a signature changes, never weakened).
- TDD for code with a unit home (read marker, `badgeManager.reset`). SW top-level listeners and the panel `send()` path have no unit home — verify them with `tsc` + `npm run build` + the manual acceptance checklist, consistent with prior SW-glue tasks.

---

### Task 1: Topic-aware read marker (F2)

**Files:**
- Modify: `src/panel/readMarker.ts`
- Modify: `src/panel/readMarker.test.ts`
- Modify: `src/panel/ThreadView.tsx`
- Modify: `src/panel/ThreadView.test.tsx`
- Modify: `src/panel/App.tsx` (the `applyCredentials` flush closure + the `onRendered` wiring)

**Interfaces:**
- Consumes: `RuntimeToSw` `{ type: 'markedRead'; topicKey: string }` (already in `src/shared/messages.ts`).
- Produces:
  - `ReadMarker.noteRendered(ids: number[], topicKey: string): void`
  - `createReadMarker` opt `flush: (ids: number[], topicKeys: string[]) => Promise<void>`
  - `ThreadView` prop `onRendered: (ids: number[], topicKey: string) => void`

- [ ] **Step 1: Write the failing F2 regression tests** — append inside the `describe('createReadMarker', …)` block in `src/panel/readMarker.test.ts`:

```ts
  test('F2: ids noted under different topics flush reporting BOTH topicKeys', async () => {
    const flushedIds: number[][] = []
    const flushedKeys: string[][] = []
    const m = createReadMarker({
      flush: async (ids, keys) => {
        flushedIds.push(ids)
        flushedKeys.push([...keys].sort())
      },
    })
    m.noteRendered([1], 'kA') // thread A rendered
    m.noteRendered([2], 'kB') // switched to thread B before the debounce fired
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushedIds).toEqual([[1, 2]])
    expect(flushedKeys).toEqual([['kA', 'kB']])
  })

  test('a failed multi-topic batch re-queues ids under their own topics and retries with both keys', async () => {
    let fail = true
    const flushedKeys: string[][] = []
    const m = createReadMarker({
      flush: async (_ids, keys) => {
        if (fail) throw new Error('offline')
        flushedKeys.push([...keys].sort())
      },
    })
    m.noteRendered([1], 'kA')
    m.noteRendered([2], 'kB')
    await vi.advanceTimersByTimeAsync(2000) // fails
    fail = false
    await vi.advanceTimersByTimeAsync(2000) // retry
    expect(flushedKeys).toEqual([['kA', 'kB']])
  })
```

- [ ] **Step 2: Update the existing read-marker tests to the new `noteRendered` signature**

Every existing `m.noteRendered([...])` call in `src/panel/readMarker.test.ts` gains a topicKey argument `'k'` (a single shared topic preserves their original single-topic behavior and assertions). The `flush:` closures are unchanged — a `flush: async (ids) => …` that ignores the new second parameter still satisfies the `(ids, topicKeys) => …` type (TypeScript allows a callback to accept fewer args). Concretely, change each call as follows (order as they appear):

```ts
// 'batches ids …'
m.noteRendered([1, 2], 'k')
m.noteRendered([2, 3], 'k')
// 'never re-flushes …'
m.noteRendered([1], 'k')
m.noteRendered([1, 2], 'k')
// 'failed ids stay queued …'
m.noteRendered([1], 'k')
m.noteRendered([2], 'k')
// 'collects nothing while not visible …'
m.noteRendered([1], 'k')
m.noteRendered([1], 'k')
// 'dispose cancels pending work'
m.noteRendered([1], 'k')
// 'dispose during an in-flight flush …'
m.noteRendered([1], 'k')
// 'drops a batch after maxRetries …'
m.noteRendered([1], 'k')
// 'a success resets the failure counter'
m.noteRendered([1], 'k')
m.noteRendered([2], 'k')
m.noteRendered([3], 'k')
// 'a newly-noted id gets a fresh retry budget …'
m.noteRendered([1], 'k')
m.noteRendered([2], 'k')
```

- [ ] **Step 3: Run the read-marker tests to verify they fail**

Run: `npx vitest run src/panel/readMarker.test.ts`
Expected: FAIL — `noteRendered` currently takes one argument / the new F2 tests reference the two-arg `flush` before the implementation exists.

- [ ] **Step 4: Rewrite `src/panel/readMarker.ts` topic-aware**

```ts
export interface ReadMarker {
  noteRendered(ids: number[], topicKey: string): void
  dispose(): void
}

/**
 * Batches read receipts per topic: dedupes against everything already flushed,
 * debounces the POST, keeps failed ids queued (under their own topic) for the
 * next attempt. On flush it marks all ids read in one call and reports the set
 * of distinct topics in the batch so the caller can zero each topic's badge.
 */
export function createReadMarker(opts: {
  flush: (ids: number[], topicKeys: string[]) => Promise<void>
  debounceMs?: number
  isVisible?: () => boolean
  maxRetries?: number
}): ReadMarker {
  const debounceMs = opts.debounceMs ?? 2000
  const isVisible = opts.isVisible ?? (() => true)
  const maxRetries = opts.maxRetries ?? 5
  const pending = new Map<string, Set<number>>() // topicKey → ids awaiting flush
  const flushed = new Set<number>() // ids confirmed read (globally unique, topic-agnostic)
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let failures = 0

  function pendingCount(): number {
    let n = 0
    for (const set of pending.values()) n += set.size
    return n
  }

  function isPending(id: number): boolean {
    for (const set of pending.values()) if (set.has(id)) return true
    return false
  }

  function requeue(batch: ReadonlyArray<readonly [string, number[]]>): void {
    for (const [key, ids] of batch) {
      let set = pending.get(key)
      if (!set) {
        set = new Set()
        pending.set(key, set)
      }
      for (const id of ids) set.add(id)
    }
  }

  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      const batch = [...pending.entries()].map(([key, set]) => [key, [...set]] as const)
      pending.clear()
      const ids = batch.flatMap(([, list]) => list)
      if (!ids.length) return
      const topicKeys = batch.map(([key]) => key)
      opts
        .flush(ids, topicKeys)
        .then(() => {
          if (disposed) return
          failures = 0
          for (const id of ids) flushed.add(id)
        })
        .catch(() => {
          if (disposed) return
          failures++
          if (failures > maxRetries) {
            // Give up on this batch: mark the ids flushed so they are not retried,
            // and reset so future messages get a fresh budget.
            for (const id of ids) flushed.add(id)
            failures = 0
            return
          }
          requeue(batch) // retry each id under its original topic
          schedule()
        })
    }, debounceMs)
  }

  return {
    noteRendered(ids, topicKey) {
      if (disposed || !isVisible()) return
      let added = false
      let set = pending.get(topicKey)
      for (const id of ids) {
        if (!flushed.has(id) && !isPending(id)) {
          if (!set) {
            set = new Set()
            pending.set(topicKey, set)
          }
          set.add(id)
          added = true
        }
      }
      if (added) failures = 0 // new content restarts the consecutive-failure budget
      if (added || pendingCount()) schedule()
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
```

- [ ] **Step 5: Run the read-marker tests to verify they pass**

Run: `npx vitest run src/panel/readMarker.test.ts`
Expected: PASS (all prior tests + the two new F2 tests).

- [ ] **Step 6: Update `ThreadView` to pass the topicKey**

In `src/panel/ThreadView.tsx`, change the `onRendered` prop type:

```ts
  onRendered: (ids: number[], topicKey: string) => void
```

and the effect call (currently `if (messages.length) onRendered(messages.map((m) => m.id))`) to guard on a real key:

```ts
    if (messages.length && threadKey) onRendered(messages.map((m) => m.id), threadKey)
```

- [ ] **Step 7: Update the `ThreadView` test for the new `onRendered` signature**

In `src/panel/ThreadView.test.tsx`, the existing "reports rendered message ids for read marking" test passes `threadKey: 'k1'`; update its assertion:

```ts
    expect(onRendered).toHaveBeenCalledWith([1, 2], 'k1')
```

Then add a guard test inside the `describe('ThreadView', …)` block:

```ts
  test('does not report rendered ids when there is no thread key', () => {
    const onRendered = vi.fn()
    renderThread({ messages: [msg(1, '<p>a</p>')], hasThread: true, threadKey: null, onRendered })
    expect(onRendered).not.toHaveBeenCalled()
  })
```

- [ ] **Step 8: Wire the panel — `App.tsx` flush closure and `onRendered`**

In `src/panel/App.tsx`, the read marker's `flush` closure (inside `applyCredentials`) becomes topic-aware — replace:

```ts
          flush: async (ids) => {
            await (clientRef.current?.markRead(ids) ?? Promise.resolve())
            const t = threadRef.current
            if (t) {
              const msg: RuntimeToSw = { type: 'markedRead', topicKey: t.key }
              void chrome.runtime.sendMessage(msg).catch(() => {})
            }
          },
```

with:

```ts
          flush: async (ids, topicKeys) => {
            await (clientRef.current?.markRead(ids) ?? Promise.resolve())
            for (const key of topicKeys) {
              const msg: RuntimeToSw = { type: 'markedRead', topicKey: key }
              void chrome.runtime.sendMessage(msg).catch(() => {})
            }
          },
```

and update the `onRendered` wiring (currently `onRendered={(ids) => readMarkerRef.current?.noteRendered(ids)}`) to forward the key:

```ts
          onRendered={(ids, key) => readMarkerRef.current?.noteRendered(ids, key)}
```

- [ ] **Step 9: Run the full panel suite + typecheck**

Run: `npx vitest run src/panel && npx tsc --noEmit`
Expected: PASS; no type errors. (`threadRef` is no longer read in the flush closure — the F2 stale-topic read is gone.)

- [ ] **Step 10: Commit**

```bash
git add src/panel/readMarker.ts src/panel/readMarker.test.ts src/panel/ThreadView.tsx src/panel/ThreadView.test.tsx src/panel/App.tsx
git commit -m "fix: topic-aware read marker so a mid-debounce thread switch zeroes the right badge (F2)"
```

---

### Task 2: badge-clear-on-logout (`badgeManager.reset()` + SW wiring)

**Files:**
- Modify: `src/background/badgeManager.ts`
- Modify: `src/background/badgeManager.test.ts`
- Modify: `src/background/index.ts` (the `credentialsStore.watch` handler)

**Interfaces:**
- Consumes: the existing `createBadgeManager` return object, `createUnreadStore` (`unreadStore.save`), `chrome.tabs.query`, `chrome.action.setBadgeText`.
- Produces: `badge.reset(): void` on the badge manager.

- [ ] **Step 1: Write the failing test** — append inside `describe('badgeManager events', …)` in `src/background/badgeManager.test.ts`:

```ts
  test('reset clears the unread map so a later event counts from zero', () => {
    const { mgr, persisted } = setup()
    mgr.seed({ [KEY]: 5 })
    mgr.reset()
    mgr.onMessageEvent(NAME, false) // increments KEY
    expect(persisted.at(-1)![KEY]).toBe(1) // 0 → 1, not 6 — proves the map was cleared
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/background/badgeManager.test.ts`
Expected: FAIL — `mgr.reset is not a function`.

- [ ] **Step 3: Add `reset()` to the badge manager**

In `src/background/badgeManager.ts`, add this method to the returned object (e.g. after `seed`):

```ts
    reset(): void {
      // Clear all counts (a later event counts from zero) and forget the active
      // topic so no stale-topic event repaints a badge after logout.
      map = {}
      activeTopicKey = null
    },
```

- [ ] **Step 4: Run the badge-manager tests to verify they pass**

Run: `npx vitest run src/background/badgeManager.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the logout clear in the service worker**

In `src/background/index.ts`, replace the existing `credentialsStore.watch(...)` handler:

```ts
credentialsStore.watch((c) => {
  badgeCreds = c
  cachedStreamId = null // realm may have changed
  cachedTopics = null
})
```

with one that clears everything on the transition to logged-out:

```ts
credentialsStore.watch((c) => {
  badgeCreds = c
  cachedStreamId = null // realm may have changed
  cachedTopics = null
  if (c === null) {
    // Logged out: drop cached counts and wipe every tab's badge so none linger.
    badge.reset()
    void unreadStore.save({}).catch(() => {})
    void chrome.tabs.query({}).then((tabs) => {
      for (const t of tabs) {
        if (t.id != null) void chrome.action.setBadgeText({ tabId: t.id, text: '' }).catch(() => {})
      }
    })
  }
})
```

- [ ] **Step 6: Typecheck + build + full suite**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: no type errors; build succeeds; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/background/badgeManager.ts src/background/badgeManager.test.ts src/background/index.ts
git commit -m "fix: clear all tab badges and reset unread state on logout"
```

---

### Task 3: Badge refresh on cold-start-load and window focus (F3, F4)

**Files:**
- Modify: `src/background/index.ts`

**Interfaces:**
- Consumes: `refreshActiveTabBadge()` (function declaration, hoisted — safe to reference above its definition), `unreadStore.load`, `credentialsStore.load`, `chrome.windows.onFocusChanged`.
- Produces: nothing new (SW wiring only).

- [ ] **Step 1: F3 — refresh once the cold-start loads resolve**

In `src/background/index.ts`, replace the two separate top-level loads:

```ts
void unreadStore.load().then((m) => badge.seed(m))
void credentialsStore.load().then((c) => {
  badgeCreds = c
  cachedStreamId = null
  cachedTopics = null
})
```

with a combined load that refreshes the active tab's badge after **both** resolve:

```ts
void Promise.all([
  unreadStore.load().then((m) => badge.seed(m)),
  credentialsStore.load().then((c) => {
    badgeCreds = c
    cachedStreamId = null
    cachedTopics = null
  }),
]).then(() => refreshActiveTabBadge())
```

(The `credentialsStore.watch(...)` handler directly below is unchanged.)

- [ ] **Step 2: F4 — refresh the badge on window focus**

In the same file, update the `chrome.windows.onFocusChanged` handler (currently only `void pushActiveEntity()`):

```ts
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    void pushActiveEntity()
    void refreshActiveTabBadge()
  }
})
```

- [ ] **Step 3: Typecheck + build + full suite**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: no type errors; build succeeds; all existing tests PASS (no assertions touched — SW top-level wiring, verified by build + manual acceptance).

- [ ] **Step 4: Commit**

```bash
git add src/background/index.ts
git commit -m "fix: refresh the badge after cold-start load (F3) and on window focus (F4)"
```

---

### Task 4: First-message `topicResolved` (F5a) + version bump

**Files:**
- Modify: `src/panel/App.tsx` (the `send()` new-topic branch)
- Modify: `package.json`, `public/manifest.json` (version → 0.7.1)

**Interfaces:**
- Consumes: `RuntimeToSw` `{ type: 'topicResolved'; topicKey: string; topicName: string }` (already imported in `App.tsx`).
- Produces: nothing new.

- [ ] **Step 1: F5a — announce the freshly-created topic to the SW**

In `src/panel/App.tsx`, inside `send()`, the new-topic branch currently ends with `setThread({ ...t, existingTopic: topic })`. Add the `topicResolved` message right after it:

```ts
        setThread({ ...t, existingTopic: topic })
        const resolved: RuntimeToSw = { type: 'topicResolved', topicKey: t.key, topicName: topic }
        void chrome.runtime.sendMessage(resolved).catch(() => {})
```

- [ ] **Step 2: Bump the version to 0.7.1**

In `package.json` set `"version": "0.7.1"`. In `public/manifest.json` set `"version": "0.7.1"`.

- [ ] **Step 3: Typecheck + build + full suite**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: no type errors; build succeeds; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/panel/App.tsx package.json public/manifest.json
git commit -m "fix: send topicResolved after first post creates a topic (F5a); v0.7.1"
```

---

## Manual Acceptance (after all tasks)

1. **F2:** open thread A on a page, scroll so its messages render, then switch to a tab with thread B **before** the 2 s debounce fires → B's badge is not wrongly zeroed; A's badge drops to `•`.
2. **F3:** let the service worker idle out (DevTools shows it inactive), then activate a threaded tab → the count appears promptly, not blank-then-≤2-min.
3. **F4:** with two browser windows, focus a window whose active tab has a thread → its badge refreshes on focus.
4. **F5a:** post the first message on a fresh page → that tab's badge shows `•` immediately, not after the next poll.
5. **Logout:** with badges showing on several tabs, log out via the panel → every tab's badge clears at once.

## Self-Review

**1. Spec coverage:**
- F2 topic-aware read marker → Task 1. ✓
- F3 cold-start refresh → Task 3 Step 1. ✓
- F4 focus refresh → Task 3 Step 2. ✓
- F5a first-message topicResolved → Task 4 Step 1. ✓
- Badge-clear-on-logout (reset + all-tabs clear + session store) → Task 2. ✓
- F5b explicitly NOT implemented (no move handling added anywhere). ✓
- Version 0.7.1 → Task 4 Step 2. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows the full code; the existing-test updates are enumerated line-by-line. ✓

**3. Type consistency:** `noteRendered(ids: number[], topicKey: string)` and `flush(ids: number[], topicKeys: string[])` are defined in Task 1 and used consistently in `App.tsx` (Task 1 Step 8) and `ThreadView` (Task 1 Steps 6–7). `badge.reset()` defined in Task 2 Step 3 and called in Task 2 Step 5. `RuntimeToSw` `markedRead`/`topicResolved` shapes match `src/shared/messages.ts`. `refreshActiveTabBadge` referenced above its declaration is valid (function declaration hoisting). ✓

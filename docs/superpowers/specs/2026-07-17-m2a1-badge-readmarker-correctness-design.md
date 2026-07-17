# PageThreads M2a-1 — SW / Badge / Read-Marker Correctness

**Date:** 2026-07-17
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §6.4 (unread badge), §3.2 (SW badge poll), §8 (failure modes). First chunk of **M2a** (backlog sweep & correctness hardening), itself the first sub-project of **M2** (§10 "Robust"). M2a splits into **M2a-1 (this: SW/badge/read-marker correctness)** and **M2a-2 (options edit-races & UX)**.

## Goal

Fix five confirmed defects in shipped M1 features so the unread badge and read-marker behavior are correct across thread switches, service-worker cold starts, window focus changes, first posts, and logout — with no new subsystem.

## Scope

In (the five items):
- **F2** — the panel's read-marker flush tags the badge-zero with `threadRef.current` at flush time, so a thread switch during the 2 s debounce zeroes the *wrong* topic's badge.
- **F3** — on a service-worker cold start, `badgeCreds`/seed load asynchronously; a badge refresh that runs first resolves to no-creds and (correctly) preserves the stale/blank badge, so the real count only lands on the next ≤2-min poll.
- **F4** — `windows.onFocusChanged` refreshes the active entity but not the badge.
- **F5a** — after `send()` creates a brand-new topic, the panel sends no `topicResolved`, so that tab's badge stays unresolved until the next poll.
- **Badge-clear-on-logout** — on credentials → null, per-tab badge overrides linger; nothing clears them.

Out (explicit non-goals):
- **F5b** (message *moved* between topics not tracked in the unread cache) — deliberately deferred. The accepted M1d-3 model is "live events are optimistic, the ≤2-min poll + on-activation recompute is authoritative," so a move's count drift self-corrects within ≤2 min. No live move handling in the badge.
- All options/panel edit-race and error-banner items — those are **M2a-2**.
- Any change to the sanitize gate, network client, or resolver.

## Design

### F2 — topic-aware read marker (`src/panel/readMarker.ts`, `src/panel/ThreadView.tsx`, `src/panel/App.tsx`)

The read marker is credentials-scoped (one instance per credentials, created in `applyCredentials`), so a single instance batches rendered message ids **across** thread switches. Today `noteRendered(ids)` collects ids into one flat `pending` set and the flush closure reads `threadRef.current.key` when the debounce fires — the F2 bug.

Make the marker topic-aware:

- `noteRendered(ids: number[], topicKey: string)` — new second parameter.
- Internal `pending` becomes `Map<string, Set<number>>` (topicKey → ids). The global `flushed` dedup stays a plain `Set<number>` (Zulip message ids are globally unique, so cross-topic dedup by id is correct). An id is added to `pending[topicKey]` only if not in `flushed` and not already pending under any topic.
- `flush` signature becomes `flush(ids: number[], topicKeys: string[]): Promise<void>` — `ids` is the union across all pending topics (one `markRead` POST), `topicKeys` is the distinct set present in this batch.
- On flush success: add every flushed id to `flushed`, reset the failure budget.
- On flush failure (within the retry budget): re-queue each id back under **its own** topicKey in `pending`, reschedule. On exhausting `maxRetries`: mark the ids flushed (drop them) and reset the budget — same give-up semantics as today, preserved per-topic.

`App`'s flush closure (in `applyCredentials`) becomes:
```ts
flush: async (ids, topicKeys) => {
  await (clientRef.current?.markRead(ids) ?? Promise.resolve())
  for (const key of topicKeys) {
    const msg: RuntimeToSw = { type: 'markedRead', topicKey: key }
    void chrome.runtime.sendMessage(msg).catch(() => {})
  }
},
```
No `threadRef` read at flush time → each topic's badge is zeroed correctly even if the user switched threads mid-debounce.

`ThreadView` already holds `threadKey`; its effect changes from `onRendered(messages.map(m => m.id))` to `onRendered(messages.map(m => m.id), threadKey)` (guarded by the existing `if (messages.length)`; skip when `threadKey` is null). `App` wires `onRendered={(ids, key) => key && readMarkerRef.current?.noteRendered(ids, key)}`. The `ReadMarker` interface's `noteRendered` type and `onRendered` prop type update accordingly.

### F3 — refresh the badge once cold-start loads resolve (`src/background/index.ts`)

The two top-level async loads (`unreadStore.load().then(seed)` and `credentialsStore.load().then(set badgeCreds)`) are restructured so that after **both** resolve, `refreshActiveTabBadge()` runs once:
```ts
void Promise.all([
  unreadStore.load().then((m) => badge.seed(m)),
  credentialsStore.load().then((c) => { badgeCreds = c; cachedStreamId = null; cachedTopics = null }),
]).then(() => refreshActiveTabBadge())
```
`refreshActiveTabBadge` is defined above these calls (or hoisted as a function declaration, which it already is), so the reference is valid. The `credentialsStore.watch` handler is unchanged. This closes the cold-start window: a woken SW paints the true count promptly instead of after the next alarm.

### F4 — refresh the badge on window focus (`src/background/index.ts`)

```ts
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    void pushActiveEntity()
    void refreshActiveTabBadge()
  }
})
```

### F5a — send `topicResolved` after first post creates a topic (`src/panel/App.tsx`)

In `send()`, immediately after the new-topic branch sets the thread:
```ts
setThread({ ...t, existingTopic: topic })
const resolved: RuntimeToSw = { type: 'topicResolved', topicKey: t.key, topicName: topic }
void chrome.runtime.sendMessage(resolved).catch(() => {})
```
This mirrors the `topicResolved` message `initThread` already sends for a pre-existing topic, so a freshly-created thread's tab shows `•` at once rather than after the next poll.

### Badge-clear-on-logout (`src/background/badgeManager.ts`, `src/background/index.ts`)

Add a `reset()` method to the badge manager that clears its in-memory state — `map` (so a later `onMessageEvent` starts from 0) and `activeTopicKey` (so no stale-topic repaint), leaving `activeTabId` untouched since the active tab hasn't changed:
```ts
reset(): void {
  map = {}
  activeTopicKey = null
}
```

In `index.ts`, the `credentialsStore.watch` handler detects the transition to logged-out and clears everything:
```ts
credentialsStore.watch((c) => {
  badgeCreds = c
  cachedStreamId = null
  cachedTopics = null
  if (c === null) {
    badge.reset()
    void unreadStore.save({}).catch(() => {})
    void chrome.tabs.query({}).then((tabs) => {
      for (const t of tabs) if (t.id != null) void chrome.action.setBadgeText({ tabId: t.id, text: '' }).catch(() => {})
    })
  }
})
```
`watch` fires on any credentials change regardless of source (panel logout, cross-window sync), so logging out anywhere clears the badge everywhere. (Login/switch — `c !== null` — is unchanged; the next refresh/poll repaints from the new realm.)

## Testing

- **Unit — `readMarker.test.ts`** (extend): `noteRendered(ids, key)` batches per topic; a batch spanning two topicKeys triggers one `flush(allIds, [keyA, keyB])`; **F2 regression** — ids noted under topic A then topic B (simulating a mid-debounce switch) flush with both keys reported, never collapsing to one topic; retry re-queues ids under their original topicKey; `maxRetries` give-up drops per topic; cross-topic dedup via the shared `flushed` set. Existing read-marker tests updated for the new `noteRendered`/`flush` signatures (behavioral assertions preserved, not weakened).
- **Unit — `badgeManager.test.ts`** (extend): `reset()` clears the map (a subsequent `onMessageEvent` starts from 0) and clears `activeTopicKey` (a later same-topic event does not repaint until re-resolved).
- **Component — `ThreadView.test.tsx`** (extend): `onRendered` is called with `(ids, threadKey)`; not called (or key-guarded) when `threadKey` is null.
- **Manual acceptance** (SW top-level wiring + panel `send()` path, which have no unit home — consistent with prior SW-glue handling):
  1. **F2:** open thread A, scroll so its messages render, then switch to thread B **before** the 2 s debounce → B's badge is not wrongly zeroed; A's badge drops to `•`.
  2. **F3:** let the SW idle out (DevTools shows it inactive), activate a threaded tab → the count appears promptly, not blank-then-≤2-min.
  3. **F4:** two windows; focus a window whose active tab has a thread → its badge refreshes on focus.
  4. **F5a:** post the first message on a fresh page → that tab's badge shows `•` immediately, not after the next poll.
  5. **Logout:** with badges showing on several tabs, log out → all per-tab badges clear at once.

## Acceptance

1. A read-marker flush that spans a thread switch zeroes each involved topic's badge correctly; no wrong-topic zero (F2).
2. A cold-started service worker paints the active tab's real count without waiting for the next poll (F3).
3. Switching window focus refreshes the active tab's badge (F4).
4. The first post on a new page resolves that tab's badge immediately (F5a).
5. Logout clears every tab's badge and resets badge state (map + session store).
6. No behavior/network/sanitize change beyond the above; message *moves* are intentionally left to recompute (F5b out of scope). Version 0.7.1; all existing tests pass (updated only for the new read-marker/`onRendered` signatures).

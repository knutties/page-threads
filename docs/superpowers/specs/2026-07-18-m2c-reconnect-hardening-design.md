# PageThreads M2c — Reconnect Hardening

**Date:** 2026-07-18
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §8 (Failure Modes — event queue expired / SW killed), §6.4 (unread badge). Third sub-project of **M2** (Robust), after **M2a** (backlog sweep) and **M2b** (offline cache), both merged at v0.8.0.

## Context

Most of §8's event-queue recovery already exists in `src/background/eventLoop.ts` and is covered by 7 unit tests: it re-registers on `BAD_EVENT_QUEUE_ID`, backs off exponentially (1s→30s, cap, reset-on-success) including when `register()` itself fails, fires `onReconnect` (which the SW broadcasts and the panel turns into a history reload), and survives consumer exceptions in `onEvent`/`onReconnect`. On service-worker restart the lifecycle recreates the loop and the panel's port reconnect reloads history.

This chunk closes the two real remaining gaps; it does **not** rebuild what already works.

## Goal

Make the event-stream reconnection precise and self-healing: fire `onReconnect` only on a genuine reconnection (not on every failed retry during an outage), and refresh the active tab's unread badge the moment the stream reconnects.

## Scope

In:
- **`onReconnect` precision** — fire `onReconnect` only when a `register()` succeeds after a queue loss, instead of when the `BAD_EVENT_QUEUE_ID` error is first seen (backlog item e). During a persistent outage this collapses N repeated firings (and N panel reloads) into a single one on eventual recovery.
- **Badge refresh on reconnect** — the SW's `onReconnect` also calls `refreshActiveTabBadge()`, so the active tab's unread count corrects immediately after a stream gap rather than waiting up to ~2 minutes for the alarm poll.

Out (explicit non-goals):
- No queue persistence / cross-restart queue *resume* (YAGNI — the loop only runs while a panel is open, and an open panel's port keeps the SW alive; `storage.session` also clears on extension reload / browser restart). Re-register + panel reload already recovers.
- No change to backoff timing, event dispatch, the panel's reconnect reload, or the badge's poll/compute logic.

## Design

### 1. `onReconnect` precision (`src/background/eventLoop.ts`)

Today, inside the `catch`, `BAD_EVENT_QUEUE_ID` fires `onReconnect` immediately (before re-registering). Two problems follow from firing on the *error*: (1) during a persistent `register()`-fails-with-`BAD` outage, it fires every backoff cycle; (2) it signals "reconnected" before we've actually reconnected.

New model — fire on the successful re-register:
- Add a loop-local `lostQueue = false` flag.
- In the top of the `try`, when `!queue`, after a successful `register()`, if `lostQueue` was set: clear it and fire `onReconnect` (wrapped in the existing try/catch so a consumer throw can't kill the loop).
- In the `catch`, for `BAD_EVENT_QUEUE_ID`: set `lostQueue = true`; if `queue` was non-null (a stale queue surfaced by `getEvents`), null it and `continue` (re-register immediately — fast path for the common case); if `queue` was already null (`register()` itself failed with `BAD`), fall through to the backoff `sleep` (preserving the existing no-hot-spin behavior).

Sketch:
```ts
let backoff = INITIAL_BACKOFF_MS
let queue: { queueId: string; lastEventId: number } | null = null
let lostQueue = false

while (this.running) {
  try {
    if (!queue) {
      queue = await this.client.register(this.channel)
      if (lostQueue) {
        lostQueue = false
        try { this.hooks.onReconnect?.() } catch { /* consumer bug must not kill the loop */ }
      }
    }
    const events = await this.client.getEvents(queue.queueId, queue.lastEventId)
    backoff = INITIAL_BACKOFF_MS
    for (const event of events) {
      if (event.id > queue.lastEventId) queue.lastEventId = event.id
      if (!this.running) break
      try { this.hooks.onEvent(event) } catch { /* consumer bug must not kill the loop */ }
    }
  } catch (e) {
    if (!this.running) return
    if (e instanceof ZulipError && e.code === 'BAD_EVENT_QUEUE_ID') {
      lostQueue = true
      if (queue) {
        queue = null
        continue // stale queue: re-register immediately (no backoff)
      }
      // register() itself failed with BAD: fall through to backoff (no hot-spin)
    }
    await sleep(backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
}
```

**Behavioral equivalence for the covered cases:** the single-reconnect case (a stale queue, then a successful re-register) still fires `onReconnect` exactly once; the "register-fails-with-`BAD` backs off" case still backs off; consumer-throw isolation is unchanged. The only observable change is during a *multi-cycle* outage, where `onReconnect` now fires once (on recovery) instead of once per cycle.

### 2. Badge refresh on reconnect (`src/background/index.ts`)

The loop's `onReconnect` hook (built in `lifecycle.makeLoop`) currently is `() => broadcast({ type: 'reconnected' })`. Extend it to also refresh the badge:
```ts
onReconnect: () => {
  broadcast({ type: 'reconnected' })
  void refreshActiveTabBadge()
},
```
Because `onReconnect` now fires only on a genuine reconnection (§1), this recomputes the active tab's unread count exactly once per real reconnection — correcting any drift from the stream gap immediately rather than at the next ≤2-minute alarm. `refreshActiveTabBadge` is already defined in `index.ts` and is safe to call (it resolves the active tab, queries `is:unread`, and no-ops if there's no thread/creds).

## Testing

- **Unit — `eventLoop.test.ts` (extend):** a new test where `register()` succeeds once (`q1`), `getEvents(q1)` throws `BAD_EVENT_QUEUE_ID`, then `register()` fails with `BAD` several times (each backing off via the injected no-op `sleep`), then finally succeeds — asserting `onReconnect` fires **exactly once** (on the final successful re-register), not once per failed cycle. This discriminates the new behavior (1) from the old (≥4). All 7 existing eventLoop tests must keep passing unchanged (they already assert one reconnect for the single-reconnect case and the backoff sequence).
- **SW wiring (`index.ts` `onReconnect`)** has no unit home; verified by `tsc` + `npm run build` + manual acceptance.
- **Manual acceptance:** with a panel open on a threaded tab, let the event queue expire (idle > ~10 min, or restart the realm so the queue is invalidated) → on recovery the panel reloads once and the badge recomputes promptly; during a sustained outage the panel does not reload repeatedly.

## Acceptance

1. `onReconnect` fires once per genuine reconnection, not once per failed retry during a sustained `BAD_EVENT_QUEUE_ID` outage (backlog e closed).
2. The no-hot-spin and single-reconnect behaviors are unchanged; all 7 existing eventLoop tests pass.
3. On a genuine reconnection the active tab's unread badge recomputes immediately (not only at the next ~2-minute poll).
4. No change to backoff, dispatch, panel reload, or badge poll/compute; no queue persistence added.
5. Version 0.8.1; the new eventLoop unit test passes and the suite stays green.

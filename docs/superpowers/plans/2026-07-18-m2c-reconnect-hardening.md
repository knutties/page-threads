# M2c Reconnect Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make event-stream reconnection precise — fire `onReconnect` only on a genuine re-register (not every failed retry), and refresh the active tab's unread badge the moment the stream reconnects.

**Architecture:** A loop-local `lostQueue` flag moves the `onReconnect` firing from "when a `BAD_EVENT_QUEUE_ID` error is seen" to "when a `register()` succeeds after a queue loss," preserving the existing no-hot-spin and single-reconnect behaviors. The service worker's `onReconnect` hook then also calls the existing `refreshActiveTabBadge()`.

**Tech Stack:** TypeScript (strict), Vitest, Chrome MV3 service worker.

## Global Constraints

- Version bumped to **0.8.1** (`package.json` + `public/manifest.json`) in the final task, verbatim.
- No change to backoff timing, event dispatch, the panel's reconnect reload, or the badge's poll/compute logic; no queue persistence added.
- All 7 existing `eventLoop.test.ts` tests must keep passing unchanged.
- TypeScript strict; the SW `onReconnect` wiring has no unit home and is verified by `tsc` + `npm run build` + manual acceptance.

---

### Task 1: `onReconnect` fires only on a genuine re-register (`eventLoop.ts`)

**Files:**
- Modify: `src/background/eventLoop.ts`
- Modify: `src/background/eventLoop.test.ts`

**Interfaces:**
- Consumes: `ZulipError` (`src/shared/zulipClient.ts`), the existing `EventLoopHooks` (`onEvent`, `onReconnect?`, `sleep?`).
- Produces: no interface change — same public `EventLoop` API; only the `onReconnect` firing semantics change.

- [ ] **Step 1: Write the failing test** — append inside `describe('EventLoop', …)` in `src/background/eventLoop.test.ts`

```ts
  test('onReconnect fires once on genuine reconnect, not per failed re-register during an outage', async () => {
    let registers = 0
    let loop: EventLoop
    const client = {
      register: async () => {
        registers++
        if (registers === 1) return { queueId: 'q1', lastEventId: -1 }
        if (registers <= 4) throw new ZulipError('bad', 'BAD_EVENT_QUEUE_ID') // re-registers 2,3,4 fail
        return { queueId: 'q5', lastEventId: -1 } // register 5 finally succeeds
      },
      getEvents: async (queueId: string) => {
        if (queueId === 'q1') throw new ZulipError('bad', 'BAD_EVENT_QUEUE_ID') // q1 goes stale
        loop.stop()
        return []
      },
    }
    let reconnects = 0
    loop = new EventLoop(client, 'web-threads', {
      onEvent: () => {},
      onReconnect: () => reconnects++,
      sleep: async () => {},
    })
    await loop.start()
    expect(reconnects).toBe(1) // only the genuine q5 reconnect — old code fired 4×
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/background/eventLoop.test.ts`
Expected: FAIL — the current code fires `onReconnect` on every `BAD_EVENT_QUEUE_ID` seen (the stale `q1` plus each failed re-register), so `reconnects` is `4`, not `1`.

- [ ] **Step 3: Rewrite `start()`** — `src/background/eventLoop.ts`

Replace the `start()` method body (the `while (this.running) { … }` block and the `let backoff` / `let queue` declarations) with this version — it adds `lostQueue` and moves the `onReconnect` firing to a successful re-register:

```ts
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const sleep = this.hooks.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    let backoff = INITIAL_BACKOFF_MS
    let queue: { queueId: string; lastEventId: number } | null = null
    let lostQueue = false // set on a queue loss; cleared when we successfully re-register

    while (this.running) {
      try {
        if (!queue) {
          queue = await this.client.register(this.channel)
          if (lostQueue) {
            lostQueue = false
            try {
              this.hooks.onReconnect?.()
            } catch {
              // A consumer bug must not kill the loop (mirrors the onEvent guard).
            }
          }
        }
        const events = await this.client.getEvents(queue.queueId, queue.lastEventId)
        backoff = INITIAL_BACKOFF_MS
        for (const event of events) {
          if (event.id > queue.lastEventId) queue.lastEventId = event.id
          if (!this.running) break
          try {
            this.hooks.onEvent(event)
          } catch {
            // A consumer bug must not kill the loop or drop the rest of the batch.
          }
        }
      } catch (e) {
        if (!this.running) return
        if (e instanceof ZulipError && e.code === 'BAD_EVENT_QUEUE_ID') {
          lostQueue = true
          if (queue) {
            queue = null
            continue // stale queue surfaced by getEvents: re-register immediately (no backoff)
          }
          // register() itself failed with this code: fall through to backoff (no hot-spin)
        }
        await sleep(backoff)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    }
  }
```

(The `INITIAL_BACKOFF_MS`/`MAX_BACKOFF_MS` constants and the `stop()` method are unchanged.)

- [ ] **Step 4: Run the eventLoop tests to verify they pass**

Run: `npx vitest run src/background/eventLoop.test.ts && npx tsc --noEmit`
Expected: PASS — the new outage test (`reconnects === 1`) plus all 7 existing tests. In particular: "re-registers on BAD_EVENT_QUEUE_ID and fires onReconnect" still sees exactly 1 reconnect (stale queue → one successful re-register); "register failing with BAD_EVENT_QUEUE_ID backs off instead of hot-spinning" still yields `sleeps === [1000]`; "an onReconnect exception does not kill the loop" still re-registers twice.

- [ ] **Step 5: Commit**

```bash
git add src/background/eventLoop.ts src/background/eventLoop.test.ts
git commit -m "fix: fire onReconnect only on a genuine re-register, not every failed retry"
```

---

### Task 2: Refresh the badge on reconnect + version bump (`index.ts`)

**Files:**
- Modify: `src/background/index.ts`
- Modify: `package.json`, `public/manifest.json` (version → 0.8.1)

**Interfaces:**
- Consumes: `refreshActiveTabBadge()` (already defined in `index.ts` as a hoisted `async function`) and the `broadcast(...)` helper.
- Produces: no interface change.

- [ ] **Step 1: Extend the `onReconnect` hook** — `src/background/index.ts`

The `makeLoop` hook is currently `onReconnect: () => broadcast({ type: 'reconnected' }),`. Replace it with one that also refreshes the badge:

```ts
      onReconnect: () => {
        broadcast({ type: 'reconnected' })
        void refreshActiveTabBadge()
      },
```

Because Task 1 makes `onReconnect` fire only on a genuine reconnection, this recomputes the active tab's unread count exactly once per real reconnection.

- [ ] **Step 2: Bump the version to 0.8.1**

In `package.json` set `"version": "0.8.1"`. In `public/manifest.json` set `"version": "0.8.1"`.

- [ ] **Step 3: Typecheck + build + full suite**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: no type errors; build succeeds; all tests PASS (the `onReconnect` wiring is SW glue — no assertions touch it; it's covered by manual acceptance).

- [ ] **Step 4: Commit**

```bash
git add src/background/index.ts package.json public/manifest.json
git commit -m "feat: refresh the active-tab badge on a genuine reconnect; v0.8.1"
```

---

## Manual Acceptance (after all tasks)

1. With a panel open on a threaded tab, let the event queue expire (idle > ~10 min, or restart the realm so the queue is invalidated). On recovery: the panel reloads history once and the badge recomputes promptly (not only at the next ~2-minute poll).
2. During a sustained outage (realm down for a while), the panel does not reload history repeatedly — it reloads once when the stream genuinely reconnects.

## Self-Review

**1. Spec coverage:**
- `onReconnect` precision (fire on successful re-register after a loss; no-hot-spin preserved) → Task 1. ✓
- Badge refresh on reconnect → Task 2 Step 1. ✓
- All 7 existing eventLoop tests kept green → Task 1 Step 4. ✓
- No queue persistence / no backoff/dispatch/reload change → nothing in the plan touches those. ✓
- Version 0.8.1 → Task 2 Step 2. ✓

**2. Placeholder scan:** No TBD/TODO; the full `start()` body and the exact `onReconnect` replacement are shown; the new test is complete. ✓

**3. Type consistency:** `lostQueue: boolean` is loop-local; `EventLoopHooks`/`onReconnect?` are unchanged; `refreshActiveTabBadge()` and `broadcast(...)` match their existing `index.ts` definitions. No signature changes. ✓

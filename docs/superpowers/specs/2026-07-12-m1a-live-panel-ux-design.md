# PageThreads M1a — Live Panel UX Design

**Date:** 2026-07-12
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §3.1, §6.3, §10.2. First of four M1 sub-projects (M1a live-panel UX → M1b auth → M1c message features → M1d rules/badge).

## Goal

The panel tracks what the user is looking at: switching tabs or navigating (including SPA navigation) updates the thread automatically, with a pin toggle to opt out. Plus the M0 review carry-forward fixes.

## Scope

In:
- Follow-active-tab (service-worker push model).
- SPA navigation detection in the content script (WHAT.md §3.1).
- Pin toggle in the panel header (runtime state; persistent default deferred to M1d settings).
- Auto-scroll (bottom on load; stick-to-bottom on append only when already near bottom, threshold 100 px).
- Per-thread composer drafts (in-memory `Map<entityUri, string>`).
- Carry-forwards: IME-safe Enter in Composer; Retry button on init failure; typed ZulipClient responses; try/catch around `onReconnect`; Zulip ≥ 9 note in dev README.

Out (later M1 chunks / M2): auth/options page, per-domain rules, unread badge, read markers, Markdown, edit/delete/reactions, SW-restart tab-map recovery, offline cache.

## Design

### Service worker (push model)

The SW owns "what should the panel show." It keeps `activeEntityUri: string | null` derived state and re-evaluates it on:
- `chrome.tabs.onActivated` (tab switch),
- incoming `pageEntity` messages (page load and SPA nav; may change the active tab's entity),
- `chrome.tabs.onRemoved` (active tab closed).

Evaluation: query the active tab (`active: true, lastFocusedWindow: true`), look up its entity, and if the resulting `entityUri` differs from the last broadcast value, broadcast `{type: 'activeEntity', entity}` to all ports (null entity allowed — e.g. chrome:// pages). The existing `getActiveEntity` request/reply stays for panel startup.

### Content script (SPA navigation)

On top of the existing load-time resolution:
- `popstate` listener;
- Navigation API `navigation.addEventListener('navigate', …)` where available (feature-detected);
- fallback: `MutationObserver` on `<title>` + a 500 ms `setInterval` diff of `location.href`.

Each trigger re-runs `canonicalize`; a fresh `pageEntity` message is sent **only when the entityUri changed** (dedupe by last-sent value). Triggers are debounced (150 ms) so a burst (popstate + title change + interval) sends once. No DOM writes.

### Panel

New pure module `panelTarget.ts` — a reducer deciding what the panel shows:

```
state: { pinned: boolean; currentUri: string | null }
event: { type: 'push'; entity: PageEntity | null }
     | { type: 'pin' } | { type: 'unpin' }
result: 'ignore' | 'switch' | 'clear'
```

Rules: pinned → pushes ignored; unpinned push with same URI → ignore; different URI → switch (re-init thread, reset messages, load that thread's draft); unpin → re-request active entity.

**Null entity while unpinned is configurable** (`onNonWebPage` setting): `'hold'` (default) keeps showing the last thread, read-only-ish (composer stays enabled — the thread is still real); `'clear'` empties the panel and disables the composer. Rationale for the default: glancing at a new-tab page or chrome:// screen shouldn't blank a thread you were reading.

### Settings foundation (new, minimal)

New `src/shared/settings.ts`: a typed read/write layer over `chrome.storage.local` with a defaults object and a `watch` helper (storage.onChanged). **Requires adding `"storage"` to the manifest's `permissions`** (M0 shipped `["sidePanel"]` only; without it `chrome.storage` is undefined and the panel crashes blank at load — found in M1a manual acceptance). M1a defines `{ onNonWebPage: 'hold' | 'clear' }` (default `'hold'`). No settings UI in M1a — the toggle surfaces on M1d's options page; until then the stored value is respected and changeable via the service-worker console. This module is deliberately the same foundation M1b (credentials) and M1d (rules, defaults) will build on.

Header gains a pin button (📌 toggling filled/outline, `title` text explains). Composer drafts: `Map<entityUri, string>` in panel memory; saved on thread switch, restored on arrival, entry cleared on successful send.

Auto-scroll in ThreadView: on `history` render, scroll to bottom; on `append`, scroll only if the scroll position was within 100 px of the bottom before the append. Pure helper `shouldStickToBottom(scrollTop, scrollHeight, clientHeight)`.

### Carry-forward fixes

1. **Composer IME guard:** ignore Enter when `e.isComposing` (or `keyCode === 229`).
2. **Init retry:** when thread initialization fails, the error bar shows a Retry button that re-runs the init sequence (re-request active entity). Composer stays disabled until init succeeds.
3. **Typed ZulipClient:** per-endpoint response interfaces (`GetStreamIdResponse`, `GetTopicsResponse`, …); `request()` stays the transport but callers cast to typed shapes at each call site; no runtime change.
4. **EventLoop:** wrap `onReconnect?.()` in try/catch (consumer bugs must not kill the loop).
5. **Docs:** dev README notes the `channel` narrow operator requires Zulip ≥ 9.

## Testing

- Unit (Vitest): `panelTarget` reducer (pin/unpin/push sequences incl. null entity under both `onNonWebPage` modes), `settings.ts` defaults/merge logic (chrome.storage faked), `shouldStickToBottom`, draft-map behavior, content-script dedupe/debounce logic (extracted pure: `NavWatcher` with injected timers), typed-response compile checks, EventLoop onReconnect-throw test.
- Manual checklist (README addition): tab switch updates panel; YouTube SPA navigation updates panel; pin holds thread while switching; unpin catches up; draft survives a tab round-trip; long thread doesn't yank scroll on new message while reading scrollback.

## Acceptance

1. Switching tabs updates the panel to the new tab's thread without reopening (the M0 e2e gap).
2. In-page SPA navigation (e.g. YouTube video → video) re-resolves within ~1 s.
3. Pin freezes the thread; unpin catches up to the active tab.
4. All new unit suites pass; existing 57 tests keep passing.

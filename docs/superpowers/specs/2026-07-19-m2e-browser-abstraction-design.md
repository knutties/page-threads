# PageThreads M2e (slice 1) — `browser.*` API Abstraction

**Date:** 2026-07-19
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §10 (Firefox port), Open Question #4 (long-poll ownership on Firefox). Fifth/last M2 sub-project, after M2a–M2d (merged at v0.8.2). This is the **first, Chrome-safe slice** of the Firefox port; the Firefox-specific work is a deferred bound backlog item (see Non-goals).

## Context

Firefox is the port target, but this dev environment cannot reliably load unpacked extensions in Firefox (the same MDM constraint that forced Chrome for Testing), so Firefox-specific code can't be verified here yet. The one part of the port that is **fully verifiable on Chrome now** — and the prerequisite for everything else — is centralizing extension-API access behind a single cross-browser seam. The code today calls `chrome.*` with promises (`await chrome.tabs.query(...)`); that works on Chrome (MV3 APIs return promises) but not on Firefox, whose `chrome.*` is callback-only and whose promise API is `browser.*`. Routing every runtime call through one `browser` seam makes the codebase cross-browser-*ready* without shipping anything untestable.

## Goal

Introduce a single `browser` module and replace every runtime `chrome.*` call with `browser.*`, with byte-for-byte identical behavior on Chrome (where `browser === chrome`), so the deferred Firefox port touches only that one seam.

## Scope

In:
- A `src/shared/browser.ts` seam: `browser = globalThis.browser ?? chrome` (a thin, zero-dependency shim).
- Replace every **runtime** `chrome.X(...)` with `browser.X(...)` across `src` (background, panel, content, options entries, and the store default-args), importing `browser` where needed.
- Defensively guard the one Chrome-only API (`sidePanel`) so a future Firefox load doesn't hard-crash.

Out (explicit non-goals — deferred bound backlog item, "Firefox platform slice"):
- The Firefox manifest (`sidebar_action` + a background **event page** instead of `service_worker`), the `sidePanel`→`sidebar_action` open wiring, a dual-build (`dist-chrome`/`dist-firefox`), resolving Open Question #4 (long-poll ownership on an event page), Firefox load-and-test, and the final decision of thin-shim vs `webextension-polyfill`.
- No behavior change; no manifest change; no new dependency.

## Design

### 1. The seam (`src/shared/browser.ts` — new)

```ts
/**
 * Cross-browser extension API. Firefox exposes the promise-based `browser.*`
 * natively; Chrome does not, so fall back to `chrome` (whose MV3 APIs already
 * return promises). This module is the single seam the (deferred) Firefox port
 * will revisit — every other module imports `browser` from here.
 */
export function resolveBrowser(
  scope: { browser?: typeof chrome; chrome?: typeof chrome } = globalThis as typeof globalThis & {
    browser?: typeof chrome
  }
): typeof chrome {
  return (scope.browser ?? scope.chrome)!
}

export const browser: typeof chrome = resolveBrowser()
```
`resolveBrowser(scope)` is factored out so the resolution logic is unit-testable with injected fakes (the `browser` const captures `globalThis` at load, which is fine — in a browser the global exists; in Node tests no consumer dereferences `browser` because unit tests inject fake stores/clients).

**Why a thin shim, not `webextension-polyfill`:** zero dependency; byte-identical on Chrome (`browser === chrome`); fully verifiable now; and it is the single point the Firefox slice revisits. The polyfill's value is normalizing Firefox messaging/async quirks — unverifiable without a Firefox environment, so adopting it now is premature. If the Firefox slice surfaces a real quirk, swap this file's internals for the polyfill then, touching nothing else.

### 2. The sweep

Replace every **runtime** `chrome.X(...)` with `browser.X(...)`, adding `import { browser } from '<relative>/shared/browser'` to each file. Sites (from a full audit):
- `src/background/index.ts` — ~19 runtime calls: `sidePanel.setPanelBehavior`, `action.setBadgeText`, `tabs.query`/`sendMessage`/`onActivated`/`onRemoved`/`onUpdated`, `windows.onFocusChanged`/`WINDOW_ID_NONE`, `alarms.create`/`onAlarm`, `runtime.onConnect`/`onMessage`, `storage.*`.
- `src/panel/App.tsx` — ~5 runtime calls: `runtime.sendMessage`/`connect`, `storage`/messaging.
- `src/content/index.ts` — 3: `runtime.sendMessage`, `runtime.onMessage`.
- `src/panel/AccountView.tsx` — 1: `runtime.openOptionsPage`.
- Store default-args: `src/shared/storage.ts`, `src/shared/unread.ts`, `src/shared/messageCache.ts`, `src/shared/credentials.ts`, `src/shared/ruleset.ts` — `chrome.storage.local|session|sync` and `chrome.storage.onChanged` defaults → `browser.storage.*`.

**Keep as-is** (do NOT change):
- **Type references** `chrome.runtime.Port` — `src/background/index.ts:13,160` and `src/panel/App.tsx:59,223`. These are ambient types from `@types/chrome`, not runtime values; `browser` is a value, not a type namespace. Leave them referencing the `chrome` type namespace.
- Doc comments mentioning `chrome.storage`/`chrome.runtime` (e.g. in `messages.ts`, `storage.ts`) — harmless prose.

**Guard the Chrome-only API:** `src/background/index.ts:10` becomes
```ts
browser.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {})
```
so a future Firefox load (no `sidePanel`) doesn't throw at background startup. (On Chrome, unchanged behavior.)

### 3. Verification

On Chrome `browser` is literally `chrome`, so this is a pure rename with no behavior change: `tsc` clean, `npm run build` succeeds, the full suite stays green (no test references a global `chrome`/`browser` — all use dependency injection). A final `grep` confirms no runtime `chrome.` remains in `src` except the four `chrome.runtime.Port` type references and comments.

## Testing

- **Unit — `browser.test.ts` (new):** `resolveBrowser({ browser: b, chrome: c })` returns `b` (prefers native `browser.*`); `resolveBrowser({ chrome: c })` returns `c` (falls back); `resolveBrowser({ browser: b })` returns `b`.
- Existing tests: unchanged — none touch a global `chrome`; the sweep is a runtime-namespace rename that doesn't alter injected-dependency call paths. Full suite stays green.
- **Manual acceptance (Chrome):** reload the extension → panel, options, badge, offline, threads all behave exactly as before (the rename is invisible on Chrome).

## Acceptance

1. `src/shared/browser.ts` exists; every runtime `chrome.X(...)` in `src` is now `browser.X(...)`; the only remaining `chrome.` are the four `chrome.runtime.Port` type references and comments.
2. No behavior change on Chrome (`browser === chrome`); `tsc`/build/suite green.
3. `sidePanel` access is optional-chained so a Firefox load won't crash the background.
4. No new dependency; no manifest change; the Firefox platform slice (manifest/sidebar/event-page/dual-build/load-test) is **not** built (deferred backlog).
5. Version 0.8.3; the new `browser.ts` unit test passes.

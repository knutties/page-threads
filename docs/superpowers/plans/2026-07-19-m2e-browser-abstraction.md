# M2e slice-1 — `browser.*` API Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every runtime `chrome.*` call through one cross-browser `browser` seam so the codebase is Firefox-ready, with byte-for-byte identical behavior on Chrome.

**Architecture:** A `src/shared/browser.ts` module exports `browser = globalThis.browser ?? chrome` (thin, zero-dependency shim). Every runtime `chrome.X(...)` becomes `browser.X(...)`; the `chrome.runtime.Port` type references stay (ambient types). The Chrome-only `sidePanel` call is optional-chained.

**Tech Stack:** TypeScript (strict), Preact, Vite, Vitest, Chrome MV3 (`@types/chrome`).

## Global Constraints

- Version bumped to **0.8.3** (`package.json` + `public/manifest.json`) in the final task, verbatim.
- No behavior change on Chrome (`browser === chrome`); no new dependency; no manifest change.
- Only **runtime** `chrome.X(...)` calls are renamed to `browser.X(...)`. The four `chrome.runtime.Port` **type** references are LEFT unchanged (`background/index.ts:13,160`; `App.tsx:59,223`); comments mentioning chrome are left as-is.
- The Firefox platform slice (manifest/`sidebar_action`/event page/dual-build/load-test) is OUT of scope (deferred backlog).
- TypeScript strict; all existing tests keep passing unchanged (none reference a global `chrome`).

---

### Task 1: The `browser` seam module

**Files:**
- Create: `src/shared/browser.ts`
- Create: `src/shared/browser.test.ts`

**Interfaces:**
- Consumes: the ambient `chrome` global (`@types/chrome`).
- Produces: `resolveBrowser(scope?): typeof chrome`; `browser: typeof chrome`.

- [ ] **Step 1: Write the failing test** — `src/shared/browser.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { resolveBrowser } from './browser'

describe('resolveBrowser', () => {
  test('prefers a native browser.* namespace when present', () => {
    const b = {} as typeof chrome
    const c = {} as typeof chrome
    expect(resolveBrowser({ browser: b, chrome: c })).toBe(b)
  })

  test('falls back to chrome when browser is absent', () => {
    const c = {} as typeof chrome
    expect(resolveBrowser({ chrome: c })).toBe(c)
  })

  test('uses browser even when chrome is also present-but-undefined', () => {
    const b = {} as typeof chrome
    expect(resolveBrowser({ browser: b })).toBe(b)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/shared/browser.test.ts`
Expected: FAIL — cannot resolve `./browser`.

- [ ] **Step 3: Implement** — `src/shared/browser.ts`

```ts
/**
 * Cross-browser extension API. Firefox exposes the promise-based `browser.*`
 * namespace natively; Chrome does not, so fall back to `chrome` (whose MV3 APIs
 * already return promises). This module is the single seam the (deferred) Firefox
 * port will revisit — every other module imports `browser` from here rather than
 * touching `chrome`/`browser` globals directly.
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

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/shared/browser.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/browser.ts src/shared/browser.test.ts
git commit -m "feat: cross-browser API seam (browser = globalThis.browser ?? chrome)"
```

---

### Task 2: Sweep runtime `chrome.*` → `browser.*` + version bump

**Files:**
- Modify: `src/background/index.ts`, `src/panel/App.tsx`, `src/panel/AccountView.tsx`, `src/content/index.ts`
- Modify: `src/shared/storage.ts`, `src/shared/unread.ts`, `src/shared/messageCache.ts`, `src/shared/credentials.ts`, `src/shared/ruleset.ts`
- Modify: `package.json`, `public/manifest.json` (version → 0.8.3)

**Interfaces:**
- Consumes: `browser` from `src/shared/browser.ts` (Task 1).
- Produces: no interface change — a pure runtime-namespace rename.

- [ ] **Step 1: Rename runtime `chrome.*` → `browser.*` in the shared store modules**

Add `import { browser } from './browser'` to each of these files and change the `chrome.storage.*` / `chrome.storage.onChanged` **default arguments** to `browser.storage.*`:
- `src/shared/storage.ts` — `createStore(..., area = browser.storage.local, changed = browser.storage.onChanged, ...)`
- `src/shared/unread.ts` — `area = browser.storage.session, changed = browser.storage.onChanged`
- `src/shared/messageCache.ts` — `area = browser.storage.local`
- `src/shared/credentials.ts` — the `chrome.storage.*` defaults → `browser.storage.*`
- `src/shared/ruleset.ts` — the `chrome.storage.sync` / `chrome.storage.onChanged` defaults → `browser.storage.*`

(Leave doc comments mentioning `chrome.storage` as prose — no code meaning.)

- [ ] **Step 2: Rename runtime `chrome.*` → `browser.*` in the content script**

In `src/content/index.ts`, add `import { browser } from '../shared/browser'` and change the runtime calls: `chrome.runtime.sendMessage(...)` → `browser.runtime.sendMessage(...)` (both call sites) and `chrome.runtime.onMessage.addListener(...)` → `browser.runtime.onMessage.addListener(...)`.

- [ ] **Step 3: Rename runtime `chrome.*` → `browser.*` in the panel**

In `src/panel/App.tsx`, add `import { browser } from '../shared/browser'` and change every runtime call — `chrome.runtime.sendMessage(...)`, `chrome.runtime.connect(...)` — to `browser.*`. **Do NOT change** the two type annotations `chrome.runtime.Port` at lines 59 and 223 (ambient types; `browser` is a value, not a type namespace).

In `src/panel/AccountView.tsx`, add `import { browser } from '../shared/browser'` and change `chrome.runtime.openOptionsPage()` → `browser.runtime.openOptionsPage()`.

- [ ] **Step 4: Rename runtime `chrome.*` → `browser.*` in the service worker + guard sidePanel**

In `src/background/index.ts`, add `import { browser } from '../shared/browser'` and change every runtime call to `browser.*`: `action.setBadgeText`, `tabs.query`/`sendMessage`/`onActivated`/`onRemoved`/`onUpdated`, `windows.onFocusChanged`/`WINDOW_ID_NONE`, `alarms.create`/`onAlarm`, `runtime.onConnect`/`onMessage`, `storage.*`. **Do NOT change** the two `chrome.runtime.Port` type annotations at lines 13 (`Set<chrome.runtime.Port>`) and 160 (`port: chrome.runtime.Port`).

Change the `sidePanel` line (currently `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})`) to optional-chain the Chrome-only API:

```ts
browser.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch(() => {})
```

- [ ] **Step 5: Confirm the sweep is complete**

Run this audit — it should print ONLY the four `chrome.runtime.Port` type references (and any comments), never a runtime `chrome.X(`:

```bash
grep -rn "chrome\." src --include="*.ts" --include="*.tsx" | grep -v "\.test\." | grep -v "^\s*\*\|//" 
```
Expected: only `chrome.runtime.Port` type usages (`background/index.ts:13,160`, `App.tsx:59,223`). If any runtime `chrome.X(` remains, convert it to `browser.X(`.

- [ ] **Step 6: Bump the version to 0.8.3**

In `package.json` set `"version": "0.8.3"`. In `public/manifest.json` set `"version": "0.8.3"`.

- [ ] **Step 7: Typecheck, build, full suite**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: no type errors; build succeeds; all tests PASS (a pure runtime rename; on Chrome `browser === chrome`, and no test references a global `chrome`).

- [ ] **Step 8: Commit**

```bash
git add src/background/index.ts src/panel/App.tsx src/panel/AccountView.tsx src/content/index.ts src/shared/storage.ts src/shared/unread.ts src/shared/messageCache.ts src/shared/credentials.ts src/shared/ruleset.ts package.json public/manifest.json
git commit -m "refactor: route runtime extension APIs through the browser seam; v0.8.3"
```

---

## Manual Acceptance (after all tasks)

1. Reload the extension in Chrome → panel opens, options page opens (the Settings button), badge updates, offline banner, threads all behave exactly as before. The rename is invisible on Chrome (`browser === chrome`).

## Self-Review

**1. Spec coverage:**
- `browser.ts` seam (thin shim + testable `resolveBrowser`) → Task 1. ✓
- Sweep every runtime `chrome.X(...)` → `browser.X(...)` across background/panel/content/options + store default-args → Task 2 Steps 1–4. ✓
- Keep the four `chrome.runtime.Port` type refs → Task 2 Steps 3–4 (explicit "do NOT change"). ✓
- Guard the Chrome-only `sidePanel` → Task 2 Step 4. ✓
- Audit that no runtime `chrome.` remains → Task 2 Step 5. ✓
- No new dependency / no manifest change / no behavior change → nothing in the plan adds a dep or touches the manifest keys. ✓
- Version 0.8.3 → Task 2 Step 6. ✓

**2. Placeholder scan:** No TBD/TODO; every step names exact files and the exact rename; the audit command is concrete; the four type-reference exceptions are enumerated with line numbers. ✓

**3. Type consistency:** `browser: typeof chrome` (Task 1) is imported and used as a value in Task 2; type positions keep the `chrome` namespace. `resolveBrowser(scope?)` signature matches its test. No new function/type names introduced beyond these. ✓

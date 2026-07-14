# PageThreads M1d-1 — Options Page + Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An options page for the deferred settings, a configurable strict-privacy resolve mode (auto vs. manual "Check for discussion"), and the three M1c-deferred hardening items.

**Architecture:** `Settings` gains `resolveMode`; a new third Vite HTML entry (`options`) renders a Preact `OptionsView` over the existing serialized-write settings store. The panel gains a thin `pendingEntity` gate layered above the untouched `panelTarget` follow/pin logic. Hardening: per-tag DOMPurify attribute allowlist (sanitizer stays the single HTML gate), a bounded read-marker retry, and a topic-move message event that removes a message from the panel when it leaves the current thread.

**Tech Stack:** Existing — TypeScript strict, Vite (multi-entry), Preact, Vitest (+ @testing-library/preact + jsdom for DOM/DOMPurify component tests), DOMPurify. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-14-m1d1-options-hardening-design.md`.

## Global Constraints

- `resolveMode: 'auto' | 'manual'`, default `'auto'` (preserves current behavior). `onNonWebPage` default stays `'hold'`.
- In `'manual'` mode NO Zulip request (`getStreamId`/`getTopics`/`getMessages`) fires for a page until the user clicks "Check for discussion".
- `renderMessage.ts` stays the ONLY HTML injection sink; sanitize-then-transform structure preserved; all 16 existing sanitizer tests pass unchanged.
- `panelTarget.ts` is NOT modified; the manual gate is App-level state only.
- Component tests that touch DOMPurify use `// @vitest-environment jsdom` (happy-dom mishandles it — established in M1c).
- `src/shared/*` keeps chrome APIs only as default parameter values.
- Version `0.4.0` in `package.json` + `public/manifest.json` (Task 6). Existing 176 tests keep passing.
- Branch `m1d1-options-hardening` off main. Commit trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LpgtuXYp32egiB82M3qkAb`

---

### Task 1: Settings gains resolveMode

**Files:**
- Modify: `src/shared/settings.ts`
- Modify: `src/shared/settings.test.ts` (append)

**Interfaces:**
- Produces (consumed by Tasks 2, 3): `Settings { onNonWebPage: 'hold'|'clear'; resolveMode: 'auto'|'manual' }`, `DEFAULT_SETTINGS.resolveMode === 'auto'`.

- [ ] **Step 1: Append the failing tests**

Append inside the existing describe in `src/shared/settings.test.ts` (the `fakeStorage` helper already exists in this file):

```ts
  test('resolveMode defaults to auto', async () => {
    const { area, changed } = fakeStorage()
    expect(await createSettingsStore(area, changed).load()).toEqual({
      onNonWebPage: 'hold',
      resolveMode: 'auto',
    })
  })

  test('both fields can be saved independently and both persist', async () => {
    const { area, changed, data } = fakeStorage()
    const store = createSettingsStore(area, changed)
    await Promise.all([store.save({ onNonWebPage: 'clear' }), store.save({ resolveMode: 'manual' })])
    expect(data.settings).toEqual({ onNonWebPage: 'clear', resolveMode: 'manual' })
  })
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/shared/settings.test.ts`
Expected: the two new tests FAIL (resolveMode missing from defaults / type).

- [ ] **Step 3: Implement**

In `src/shared/settings.ts`, change the interface and defaults:

```ts
export interface Settings {
  /** Panel behavior when the active tab has no web entity (chrome://, new tab). */
  onNonWebPage: 'hold' | 'clear'
  /** 'auto' resolves the thread when the panel opens; 'manual' waits for a click (strict privacy). */
  resolveMode: 'auto' | 'manual'
}

export const DEFAULT_SETTINGS: Settings = {
  onNonWebPage: 'hold',
  resolveMode: 'auto',
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/shared/settings.test.ts && npx tsc --noEmit`
Expected: all settings tests pass; tsc clean. (Existing 5 settings tests unchanged and passing.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/settings.ts src/shared/settings.test.ts
git commit -m "feat: add resolveMode setting (auto/manual strict-privacy)"
```

---

### Task 2: Options page (new Vite entry + OptionsView)

**Files:**
- Create: `src/options/index.html`, `src/options/main.tsx`, `src/options/OptionsView.tsx`, `src/options/options.css`
- Modify: `vite.config.ts` (add `options` HTML entry), `public/manifest.json` (add `options_page`)
- Test: `src/options/OptionsView.test.tsx`

**Interfaces:**
- Consumes: `Settings`, `DEFAULT_SETTINGS`, `createSettingsStore`, `SettingsStore` (Task 1 / existing).
- Produces (consumed by Task 3's AccountView link): the options page at `src/options/index.html`, registered via `options_page`.

- [ ] **Step 1: Write the failing test**

`src/options/OptionsView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, test } from 'vitest'
import type { Settings, SettingsStore } from '../shared/settings'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { OptionsView } from './OptionsView'

function fakeStore(initial: Settings = DEFAULT_SETTINGS): SettingsStore & { current: Settings } {
  let current = { ...initial }
  const store = {
    current,
    load: async () => current,
    save: async (patch: Partial<Settings>) => {
      current = { ...current, ...patch }
      ;(store as { current: Settings }).current = current
    },
    watch: () => () => {},
  }
  return store as SettingsStore & { current: Settings }
}

describe('OptionsView', () => {
  test('reflects stored values on load', async () => {
    render(<OptionsView store={fakeStore({ onNonWebPage: 'clear', resolveMode: 'manual' })} />)
    const strict = (await screen.findByLabelText(/Strict privacy/i)) as HTMLInputElement
    expect(strict.checked).toBe(true)
    const hold = (await screen.findByLabelText(/keep the last thread/i)) as HTMLInputElement
    expect(hold.checked).toBe(false)
  })

  test('toggling strict privacy writes resolveMode', async () => {
    const store = fakeStore()
    render(<OptionsView store={store} />)
    const strict = (await screen.findByLabelText(/Strict privacy/i)) as HTMLInputElement
    expect(strict.checked).toBe(false)
    fireEvent.click(strict)
    await waitFor(() => expect(store.current.resolveMode).toBe('manual'))
  })

  test('toggling the non-web-page option writes onNonWebPage', async () => {
    const store = fakeStore()
    render(<OptionsView store={store} />)
    const hold = (await screen.findByLabelText(/keep the last thread/i)) as HTMLInputElement
    fireEvent.click(hold) // was checked (hold); unchecking selects 'clear'
    await waitFor(() => expect(store.current.onNonWebPage).toBe('clear'))
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/options/OptionsView.test.tsx`
Expected: FAIL — cannot resolve `./OptionsView`.

- [ ] **Step 3: Implement OptionsView**

`src/options/OptionsView.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks'
import { createSettingsStore, DEFAULT_SETTINGS, type Settings, type SettingsStore } from '../shared/settings'

export function OptionsView({ store = createSettingsStore() }: { store?: SettingsStore }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void store.load().then((s) => {
      setSettings(s)
      setLoaded(true)
    })
    return store.watch(setSettings)
  }, [])

  async function update(patch: Partial<Settings>) {
    const next = { ...settings, ...patch }
    setSettings(next)
    await store.save(patch)
  }

  if (!loaded) return <div class="loading">Loading…</div>

  return (
    <div class="options">
      <h1>PageThreads settings</h1>

      <section>
        <label>
          <input
            type="checkbox"
            checked={settings.resolveMode === 'manual'}
            onChange={(e) =>
              void update({ resolveMode: (e.target as HTMLInputElement).checked ? 'manual' : 'auto' })
            }
          />
          Strict privacy: don't contact the realm until I click "Check for discussion"
        </label>
        <p class="hint">
          When on, opening the panel shows the page title and a button; no request is made to your Zulip
          realm for a page until you ask.
        </p>
      </section>

      <section>
        <label>
          <input
            type="checkbox"
            checked={settings.onNonWebPage === 'hold'}
            onChange={(e) =>
              void update({ onNonWebPage: (e.target as HTMLInputElement).checked ? 'hold' : 'clear' })
            }
          />
          On a non-web page (new tab, chrome://), keep the last thread visible
        </label>
        <p class="hint">When off, the panel clears and disables the composer on non-web pages.</p>
      </section>
    </div>
  )
}
```

`src/options/main.tsx`:

```tsx
import { render } from 'preact'
import { OptionsView } from './OptionsView'
import './options.css'

render(<OptionsView />, document.getElementById('root')!)
```

`src/options/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>PageThreads settings</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/options/options.css`:

```css
:root { font-family: system-ui, sans-serif; font-size: 14px; color: #222; }
* { box-sizing: border-box; }
body { margin: 0; }
.options { max-width: 640px; margin: 24px auto; padding: 0 16px; }
.options h1 { font-size: 20px; }
.options section { margin: 20px 0; }
.options label { display: flex; gap: 8px; align-items: flex-start; font-weight: 600; }
.options .hint { margin: 4px 0 0 24px; color: #666; font-weight: 400; }
.loading { padding: 24px; color: #777; }
```

- [ ] **Step 4: Register the entry and options_page**

In `vite.config.ts`, add `options` to `rollupOptions.input`:

```ts
      input: {
        panel: 'src/panel/index.html',
        options: 'src/options/index.html',
        background: 'src/background/index.ts',
      },
```

In `public/manifest.json`, add after `side_panel`:

```json
  "options_page": "src/options/index.html",
```

- [ ] **Step 5: Run to verify green + build**

Run: `npx vitest run src/options/OptionsView.test.tsx`
Expected: PASS (3 tests).
Run: `npm run build`
Expected: exit 0; `dist/src/options/index.html` present.
Run: `npx tsc --noEmit && npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/options vite.config.ts public/manifest.json
git commit -m "feat: options page with strict-privacy and non-web-page toggles"
```

---

### Task 3: Panel manual-resolution gate

**Files:**
- Create: `src/panel/resolveGate.ts`
- Modify: `src/panel/App.tsx`, `src/panel/AccountView.tsx`, `src/panel/style.css` (append)
- Test: `src/panel/resolveGate.test.ts`

**Interfaces:**
- Consumes: `Settings.resolveMode` (Task 1).
- Produces (consumed within App): `shouldGate(resolveMode: 'auto'|'manual', alreadyChecked: boolean): boolean`.

- [ ] **Step 1: Write the failing test**

`src/panel/resolveGate.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { shouldGate } from './resolveGate'

describe('shouldGate', () => {
  test('auto mode never gates', () => {
    expect(shouldGate('auto', false)).toBe(false)
    expect(shouldGate('auto', true)).toBe(false)
  })

  test('manual mode gates until the user has checked', () => {
    expect(shouldGate('manual', false)).toBe(true)
    expect(shouldGate('manual', true)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/panel/resolveGate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/panel/resolveGate.ts`:

```ts
/** True when the panel must wait for an explicit "Check for discussion" click before resolving. */
export function shouldGate(resolveMode: 'auto' | 'manual', alreadyChecked: boolean): boolean {
  return resolveMode === 'manual' && !alreadyChecked
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/panel/resolveGate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the gate into App**

In `src/panel/App.tsx`:

1. Add the import: `import { shouldGate } from './resolveGate'`.
2. Add state near the other useState hooks:

```ts
  const [pendingEntity, setPendingEntity] = useState<PageEntity | null>(null)
  const checkedRef = useRef(false)
```

3. Replace the `applyPush` `switch`-action branch. The current branch is:

```ts
    if (action === 'switch' && entity) {
      const generation = ++initGenRef.current
      setError(null)
      setThread(null)
      setEditState(null)
      dispatch({ type: 'history', messages: [] })
      setDraftText(drafts.get(entity.entityUri))
      initThread(entity).catch((e) => {
        if (generation !== initGenRef.current) return
        setError(errText(e))
        targetRef.current = panelTarget(
          targetRef.current,
          { type: 'initFailed', uri: entity.entityUri },
          settingsRef.current.onNonWebPage
        ).state
      })
    } else if (action === 'clear') {
```

Replace it with (a new switch resets `checked`, and manual mode stops before `initThread`):

```ts
    if (action === 'switch' && entity) {
      checkedRef.current = false
      setError(null)
      setThread(null)
      setEditState(null)
      dispatch({ type: 'history', messages: [] })
      setDraftText(drafts.get(entity.entityUri))
      if (shouldGate(settingsRef.current.resolveMode, checkedRef.current)) {
        setPendingEntity(entity)
      } else {
        setPendingEntity(null)
        void resolveEntity(entity)
      }
    } else if (action === 'clear') {
      setPendingEntity(null)
```

(keep the rest of the `clear` branch — `setThread(null)`, `setEditState(null)`, the history dispatch, `setDraftText('')` — exactly as it is.)

4. Extract the init-with-generation logic into a helper `resolveEntity` (so both the switch branch and the Check button call the same thing). Add this method alongside `initThread`:

```ts
  function resolveEntity(entity: PageEntity) {
    const generation = ++initGenRef.current
    return initThread(entity).catch((e) => {
      if (generation !== initGenRef.current) return
      setError(errText(e))
      targetRef.current = panelTarget(
        targetRef.current,
        { type: 'initFailed', uri: entity.entityUri },
        settingsRef.current.onNonWebPage
      ).state
    })
  }
```

5. Add the Check handler:

```ts
  function checkForDiscussion() {
    const entity = pendingEntity
    if (!entity) return
    checkedRef.current = true
    setPendingEntity(null)
    void resolveEntity(entity)
  }
```

6. In the render, add the gate view just before the `<ThreadView …>` element:

```tsx
      {pendingEntity ? (
        <div class="gate">
          <div class="gate-title">{pendingEntity.title || pendingEntity.entityUri}</div>
          <button onClick={checkForDiscussion}>Check for discussion</button>
          <p class="hint">Strict privacy is on. No request is sent to your realm until you click.</p>
        </div>
      ) : (
        <ThreadView
          messages={messages}
          hasThread={!!thread?.existingTopic}
          noPage={!thread && !error}
          threadKey={thread?.key ?? null}
          ownEmail={credentials.email}
          ownUserId={ownUserId}
          realmUrl={credentials.realmUrl}
          editState={editState}
          busy={actionBusy}
          onStartEdit={(id) => void startEdit(id)}
          onCancelEdit={() => setEditState(null)}
          onSaveEdit={(id, content) => void saveEdit(id, content)}
          onDelete={(id) => void deleteMessage(id)}
          onToggleReaction={(id, r) => void toggleReaction(id, r)}
          onRendered={(ids) => readMarkerRef.current?.noteRendered(ids)}
        />
      )}
```

(Replace the existing standalone `<ThreadView … />` element with this conditional; the Composer stays after it, unchanged — it is already `disabled={!thread}`, so it stays disabled while the gate shows.)

7. `resetThreadState` also clears the gate — add `setPendingEntity(null)` and `checkedRef.current = false` to it.

- [ ] **Step 6: Add the Settings link to AccountView**

In `src/panel/AccountView.tsx`, add a Settings button next to Sign out (both in the same area):

```tsx
      <button onClick={() => chrome.runtime.openOptionsPage()}>Settings</button>
```

Place it just before the existing `Sign out` button inside the account view's action area. (Its click opens the options tab.)

- [ ] **Step 7: Append styles**

Append to `src/panel/style.css`:

```css
.gate { flex: 1; display: flex; flex-direction: column; gap: 10px; align-items: center; justify-content: center; padding: 24px; text-align: center; }
.gate-title { font-weight: 600; overflow-wrap: anywhere; }
.gate .hint { color: #777; font-size: 12px; }
```

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/panel/resolveGate.ts src/panel/resolveGate.test.ts src/panel/App.tsx src/panel/AccountView.tsx src/panel/style.css
git commit -m "feat: strict-privacy resolution gate in the panel; settings link"
```

---

### Task 4: Per-tag sanitizer attribute allowlist

**Files:**
- Modify: `src/panel/renderMessage.ts`
- Modify: `src/panel/renderMessage.test.ts` (append negatives; existing 16 unchanged)

**Interfaces:** unchanged (`sanitizeMessageHtml(html, realmUrl)`).

- [ ] **Step 1: Append the failing negative tests**

Append inside the existing describe blocks (jsdom pragma already at top of file) in `src/panel/renderMessage.test.ts`:

```ts
describe('sanitizeMessageHtml — per-tag attribute allowlist', () => {
  test('href only survives on anchors, dropped elsewhere', () => {
    const out = s('<td href="https://evil.com/x">c</td>')
    expect(out).toContain('<td')
    expect(out).not.toContain('href')
  })

  test('datetime only survives on <time>', () => {
    expect(s('<span datetime="2020-01-01">x</span>')).not.toContain('datetime')
    expect(s('<time datetime="2020-01-01">x</time>')).toContain('datetime')
  })

  test('start only survives on <ol>', () => {
    expect(s('<ul start="3"><li>x</li></ul>')).not.toContain('start')
    expect(s('<ol start="3"><li>x</li></ol>')).toContain('start')
  })

  test('align only survives on table cells', () => {
    expect(s('<p align="center">x</p>')).not.toContain('align')
    expect(s('<td align="right">x</td>')).toContain('align')
  })

  test('class still survives on any allowed tag', () => {
    expect(s('<span class="user-mention">x</span>')).toContain('class="user-mention"')
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/panel/renderMessage.test.ts`
Expected: the new negatives FAIL (global allowlist currently keeps these attributes on any tag).

- [ ] **Step 3: Implement the per-tag hook**

In `src/panel/renderMessage.ts`, replace the `ALLOWED_ATTR` constant and the sanitize call. Change `ALLOWED_ATTR` to the union still needed by DOMPurify's own pass (it must be permissive enough that the hook can then prune per-tag):

```ts
const ALLOWED_ATTR = ['href', 'title', 'class', 'datetime', 'start', 'align', 'src']

/** Which attributes are valid on which tags (class is allowed on all). */
const ATTR_BY_TAG: Record<string, Set<string>> = {
  A: new Set(['href', 'title']),
  TIME: new Set(['datetime']),
  OL: new Set(['start']),
  TD: new Set(['align']),
  TH: new Set(['align']),
  IMG: new Set(['src']),
}
```

Then wrap the sanitize call with a per-attribute hook (this runs during DOMPurify's own pass, before the existing template transform):

```ts
export function sanitizeMessageHtml(html: string, realmUrl: string): string {
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName
    if (name === 'class') return // allowed on any allowlisted tag
    const allowed = ATTR_BY_TAG[node.tagName]
    if (!allowed || !allowed.has(name)) {
      data.keepAttr = false
    }
  })
  try {
    const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false })
    // ... existing template-based transform (a/img rewrite) UNCHANGED ...
    const tpl = document.createElement('template')
    tpl.innerHTML = clean
    for (const a of Array.from(tpl.content.querySelectorAll('a'))) {
      const abs = a.getAttribute('href') ? resolveHttpUrl(a.getAttribute('href')!, realmUrl) : null
      if (abs) a.setAttribute('href', abs)
      else a.removeAttribute('href')
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
    for (const img of Array.from(tpl.content.querySelectorAll('img'))) {
      const abs = img.getAttribute('src') ? resolveHttpUrl(img.getAttribute('src')!, realmUrl) : null
      const button = document.createElement('button')
      button.setAttribute('type', 'button')
      button.setAttribute('class', 'img-placeholder')
      if (abs) button.setAttribute('data-src', abs)
      button.textContent = '🖼️ Load image'
      img.replaceWith(button)
    }
    return tpl.innerHTML
  } finally {
    DOMPurify.removeAllHooks()
  }
}
```

Note: keep the exact existing transform body — only the `addHook`/`removeAllHooks` wrapping and the `ATTR_BY_TAG` map are new. `removeAllHooks()` in `finally` prevents the hook leaking into other DOMPurify uses/tests. The read of `img[src]` in the transform still works because `IMG` is in `ATTR_BY_TAG`.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/panel/renderMessage.test.ts`
Expected: PASS — 16 existing + 5 new. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/panel/renderMessage.ts src/panel/renderMessage.test.ts
git commit -m "harden: per-tag attribute allowlist in the message sanitizer"
```

---

### Task 5: Read-marker retry cap + topic-move handling

**Files:**
- Modify: `src/panel/readMarker.ts`, `src/panel/readMarker.test.ts` (append)
- Modify: `src/shared/messages.ts`, `src/background/index.ts`, `src/panel/App.tsx`

**Interfaces:**
- Produces: `createReadMarker` gains `maxRetries?: number` (default 5); SW `SwToPanel` gains `{ type: 'messageMoved'; messageId: number; newTopic: string }`.

- [ ] **Step 1: Append the failing read-marker cap tests**

Append inside the describe in `src/panel/readMarker.test.ts`:

```ts
  test('drops a batch after maxRetries consecutive failures', async () => {
    let attempts = 0
    const flushed: number[][] = []
    const m = createReadMarker({
      flush: async (ids) => {
        attempts++
        throw new Error('offline')
        flushed.push(ids)
      },
      maxRetries: 3,
    })
    m.noteRendered([1])
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2000)
    // 1 initial + 3 retries = 4 attempts, then the batch is dropped (no more retries)
    expect(attempts).toBe(4)
    expect(flushed).toEqual([])
  })

  test('a success resets the failure counter', async () => {
    let fail = true
    let attempts = 0
    const m = createReadMarker({
      flush: async () => {
        attempts++
        if (fail) throw new Error('offline')
      },
      maxRetries: 3,
    })
    m.noteRendered([1])
    await vi.advanceTimersByTimeAsync(2000) // attempt 1 fails
    fail = false
    m.noteRendered([2])
    await vi.advanceTimersByTimeAsync(2000) // attempt 2 succeeds ([1,2]) → counter resets
    fail = true
    m.noteRendered([3])
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2000)
    // attempt 2 succeeded, so [3] gets a fresh budget: 1 + 3 = 4 failing attempts for it
    expect(attempts).toBe(1 + 1 + 4)
  })
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/panel/readMarker.test.ts`
Expected: the 2 new tests FAIL (unbounded retry: attempts keep climbing).

- [ ] **Step 3: Implement the cap**

In `src/panel/readMarker.ts`, add `maxRetries` and a failure counter. Change the options type and the flush `.catch`:

```ts
export function createReadMarker(opts: {
  flush: (ids: number[]) => Promise<void>
  debounceMs?: number
  isVisible?: () => boolean
  maxRetries?: number
}): ReadMarker {
  const debounceMs = opts.debounceMs ?? 2000
  const isVisible = opts.isVisible ?? (() => true)
  const maxRetries = opts.maxRetries ?? 5
  const pending = new Set<number>()
  const flushed = new Set<number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let failures = 0
```

In the `schedule()` timer body's flush call, replace the existing `.then`/`.catch`:

```ts
      opts
        .flush(ids)
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
          for (const id of ids) pending.add(id) // retry on the next schedule
          schedule()
        })
```

Note: the `schedule()` re-arm inside `.catch` is needed because failing ids were re-added to `pending` after the timer already fired; without it a failed batch with no new `noteRendered` would never retry. (Guard: `schedule` clears any existing timer first, so this is safe.)

- [ ] **Step 4: Run read-marker tests green**

Run: `npx vitest run src/panel/readMarker.test.ts`
Expected: PASS (existing + 2 new). Note the existing "failed ids stay queued and retry on the next flush" test still passes because a single failure (< maxRetries) still re-queues.

- [ ] **Step 5: Add the messageMoved event and reducer path**

In `src/shared/messages.ts`, extend `SwToPanel`:

```ts
  | { type: 'messageMoved'; messageId: number; newTopic: string }
```

In `src/background/index.ts`, in the lifecycle's `onEvent` (the `update_message` branch), broadcast a move when the event carries a topic change. Change the `update_message` handling to:

```ts
        } else if (event.type === 'update_message' && event.message_id != null) {
          if (event.rendered_content != null) {
            broadcast({ type: 'messageUpdated', messageId: event.message_id, renderedContent: event.rendered_content })
          }
          if (event.subject != null && event.orig_subject != null && event.subject !== event.orig_subject) {
            broadcast({ type: 'messageMoved', messageId: event.message_id, newTopic: event.subject })
          }
        }
```

Add `subject?: string` and `orig_subject?: string` to `ZulipEvent` in `src/shared/zulipClient.ts` (alongside the existing optional event fields).

- [ ] **Step 6: Handle messageMoved in App**

In `src/panel/App.tsx`'s `handleMessage`, add a branch after `messageDeleted`:

```ts
      } else if (msg.type === 'messageMoved') {
        const t = threadRef.current
        // Removed from THIS thread if it moved to a topic that isn't ours.
        if (t && !topicMatchesKey(msg.newTopic, t.key)) {
          dispatch({ type: 'remove', id: msg.messageId })
          setEditState((cur) => (cur?.id === msg.messageId ? null : cur))
        }
```

(`topicMatchesKey` is already imported. Reuses the existing `remove` reducer action from M1c — no reducer change.)

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/panel/readMarker.ts src/panel/readMarker.test.ts src/shared/messages.ts src/shared/zulipClient.ts src/background/index.ts src/panel/App.tsx
git commit -m "harden: bounded read-marker retries; remove messages moved out of the thread"
```

---

### Task 6: Docs, version 0.4.0, checklist

**Files:**
- Modify: `package.json`, `public/manifest.json`, `README.md`

- [ ] **Step 1: Version + docs**

1. `package.json` + `public/manifest.json`: `"version": "0.4.0"`.
2. `README.md` "Current state" line → `**M1d-1** (options page, strict-privacy mode, hardening; see docs/superpowers/specs/).`
3. `README.md` — after the M1c checklist add:

```markdown
## M1d-1 acceptance checklist

- [ ] The options page opens from the panel's ⚙️ → Settings and from chrome://extensions.
- [ ] Both toggles reflect stored values and take effect in an open panel without reload.
- [ ] With strict privacy ON: opening the panel on a fresh page shows the page title and a "Check for discussion" button; DevTools Network shows ZERO requests to the realm until it is clicked; clicking resolves the thread.
- [ ] With strict privacy OFF: the panel auto-resolves as before.
- [ ] Toggling "keep the last thread on non-web pages" changes panel behavior on a chrome:// tab live.
- [ ] Moving a message to a different topic in the Zulip web UI removes it from the open panel thread.
- [ ] A message with markup renders unchanged (per-tag attribute hardening is invisible to normal content).
```

- [ ] **Step 2: Verify and commit**

Run: `npm run build && npm test && npx tsc --noEmit` — all green.

```bash
git add package.json public/manifest.json README.md
git commit -m "docs: M1d-1 acceptance checklist; version 0.4.0"
```

---

## Plan self-review notes

- **Spec coverage:** resolveMode setting (T1), options page + entry + options_page (T2), manual gate + settings link (T3), per-tag sanitizer (T4), read-marker cap + topic-move (T5), docs/version (T6). All spec sections placed.
- **Type consistency:** `Settings.resolveMode` (T1) used by OptionsView (T2), `shouldGate` (T3), settingsRef in App; `SwToPanel` messageMoved (T5) consumed in App handleMessage; `resolveEntity`/`checkForDiscussion`/`pendingEntity` all defined in T3; `maxRetries` option (T5) matches the read-marker call site (App constructs the marker in `applyCredentials` — default 5 applies, no call-site change needed).
- **Invariant preserved:** T4 keeps renderMessage.ts the single HTML sink and the sanitize-then-transform body byte-for-byte; only hook wrapping added. `removeAllHooks()` in `finally` prevents cross-test hook leakage.
- **panelTarget untouched:** T3's gate is App state layered above the reducer; the reducer file is not in any task's file list.

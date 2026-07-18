# M2a-2 Options Edit-Races & UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five options-page defects — the concurrent-save stale-revert race, the error banner that never clears on success, tab-close loss of an unflushed rule edit, cross-profile `watch` clobbering an in-progress edit, and the missing subdomain→registrable warning.

**Architecture:** A shared `optimisticSave` helper replaces both components' bespoke optimistic-rollback with revert-to-store-truth (kills stale-revert) + clear-error-on-success. `RulesEditor` gains a `visibilitychange` blur-flush and a focus-gated `watch` buffer, plus a `registrableNote` warn-but-allow note.

**Tech Stack:** TypeScript (strict), Preact, Vite, Vitest + @testing-library/preact + jsdom, tldts (`getDomain`).

## Global Constraints

- Version bumped to **0.7.2** (`package.json` + `public/manifest.json`), verbatim.
- **All changes confined to `src/options`.** No network/sanitize/resolver/badge change; no change to matching/canonicalization semantics (the registrable-domain collapse stays — we only warn).
- Error message copy is exactly `Could not save — try again.` (unchanged from current).
- TypeScript strict; existing options tests keep passing, updated only for the refactor, never weakened.
- TDD for pure helpers (`optimisticSave`, `registrableNote`); component behaviors verified with jsdom component tests.

---

### Task 1: Shared `optimisticSave` helper

**Files:**
- Create: `src/options/optimisticSave.ts`
- Create: `src/options/optimisticSave.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `optimisticSave<T>(deps: { next: T; apply: (v: T) => void; persist: (v: T) => Promise<void>; reload: () => Promise<T>; onSuccess: () => void; onError: (message: string) => void }): Promise<void>`

- [ ] **Step 1: Write the failing test** — `src/options/optimisticSave.test.ts`

```ts
import { describe, expect, test, vi } from 'vitest'
import { optimisticSave } from './optimisticSave'

describe('optimisticSave', () => {
  test('applies optimistically then onSuccess on success, without reloading', async () => {
    const apply = vi.fn()
    const reload = vi.fn(async () => 'RELOADED')
    const onSuccess = vi.fn()
    const onError = vi.fn()
    await optimisticSave({ next: 'NEXT', apply, persist: async () => {}, reload, onSuccess, onError })
    expect(apply.mock.calls).toEqual([['NEXT']])
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  test('on save failure reverts to reloaded store truth and reports the error', async () => {
    const applied: string[] = []
    const onSuccess = vi.fn()
    const onError = vi.fn()
    await optimisticSave({
      next: 'NEXT',
      apply: (v) => applied.push(v),
      persist: async () => {
        throw new Error('quota')
      },
      reload: async () => 'TRUTH',
      onSuccess,
      onError,
    })
    expect(applied).toEqual(['NEXT', 'TRUTH']) // optimistic, then reverted to store truth (not a stale snapshot)
    expect(onError).toHaveBeenCalledWith('Could not save — try again.')
    expect(onSuccess).not.toHaveBeenCalled()
  })

  test('revert reflects the CURRENT store, not the pre-edit value (stale-revert gone)', async () => {
    let truth = 'S0'
    const applied: string[] = []
    await optimisticSave({
      next: 'A',
      apply: (v) => applied.push(v),
      persist: async () => {
        truth = 'B' // a concurrent edit B won the store before A's save rejected
        throw new Error('A failed')
      },
      reload: async () => truth,
      onSuccess: () => {},
      onError: () => {},
    })
    expect(applied).toEqual(['A', 'B']) // NOT ['A', 'S0'] — no revert to a stale pre-edit snapshot
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/options/optimisticSave.test.ts`
Expected: FAIL — cannot resolve `./optimisticSave`.

- [ ] **Step 3: Implement** — `src/options/optimisticSave.ts`

```ts
/**
 * Optimistic write with revert-to-store-truth. Applies `next` immediately, then
 * persists; on success clears the error via onSuccess; on failure re-reads the
 * store (the serialized source of truth) and applies that — never a stale
 * in-memory snapshot, so a rejected earlier save can't discard a later edit.
 */
export async function optimisticSave<T>(deps: {
  next: T
  apply: (value: T) => void
  persist: (value: T) => Promise<void>
  reload: () => Promise<T>
  onSuccess: () => void
  onError: (message: string) => void
}): Promise<void> {
  deps.apply(deps.next)
  try {
    await deps.persist(deps.next)
    deps.onSuccess()
  } catch {
    deps.apply(await deps.reload())
    deps.onError('Could not save — try again.')
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/options/optimisticSave.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/options/optimisticSave.ts src/options/optimisticSave.test.ts
git commit -m "feat: optimisticSave helper (revert-to-store-truth, clear error on success)"
```

---

### Task 2: Adopt `optimisticSave` in OptionsView + RulesEditor (kills stale-revert + clears banner)

**Files:**
- Modify: `src/options/OptionsView.tsx`
- Modify: `src/options/RulesEditor.tsx`
- Modify: `src/options/OptionsView.test.tsx`
- Modify: `src/options/RulesEditor.test.tsx`

**Interfaces:**
- Consumes: `optimisticSave` (Task 1).
- Produces: no new interface. `OptionsView.update`, `RulesEditor.apply`, `RulesEditor.replaceAll` now route through `optimisticSave`; every successful save clears the error banner.

- [ ] **Step 1: Rewrite `OptionsView.update`** — `src/options/OptionsView.tsx`

Add the import (below the existing imports):

```ts
import { optimisticSave } from './optimisticSave'
```

Replace the `update` function (currently the `const prev = settings; setSettings(...); try/catch` block):

```ts
  async function update(patch: Partial<Settings>) {
    await optimisticSave<Settings>({
      next: { ...settings, ...patch },
      apply: setSettings,
      persist: () => store.save(patch),
      reload: () => store.load(),
      onSuccess: () => setError(null),
      onError: setError,
    })
  }
```

- [ ] **Step 2: Rewrite `RulesEditor.apply` and `replaceAll`** — `src/options/RulesEditor.tsx`

Add the import:

```ts
import { optimisticSave } from './optimisticSave'
```

Replace both `apply` and `replaceAll` (the two optimistic-then-rollback functions) with:

```ts
  function flashSaved() {
    setError(null)
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  async function apply(action: RulesAction) {
    const next = rulesReducer(ruleset, action)
    await optimisticSave<Ruleset>({
      next,
      apply: setRuleset,
      persist: () => store.save(next),
      reload: () => store.load(),
      onSuccess: flashSaved,
      onError: setError,
    })
  }

  async function replaceAll(next: Ruleset) {
    await optimisticSave<Ruleset>({
      next,
      apply: setRuleset,
      persist: () => store.save(next),
      reload: () => store.load(),
      onSuccess: flashSaved,
      onError: setError,
    })
  }
```

- [ ] **Step 3: Add the failing "error clears on success" test — OptionsView** — append inside `describe('OptionsView', …)` in `src/options/OptionsView.test.tsx`

```ts
  test('a successful save clears a prior error banner', async () => {
    const store = fakeStore()
    let failNext = true
    const ok = store.save.bind(store)
    store.save = async (patch: Partial<Settings>) => {
      if (failNext) {
        failNext = false
        throw new Error('quota')
      }
      return ok(patch)
    }
    render(<OptionsView store={store} rulesStore={fakeRulesStore()} />)
    const strict = (await screen.findByLabelText(/Strict privacy/i)) as HTMLInputElement
    fireEvent.click(strict) // first save fails → banner appears
    await waitFor(() => expect(screen.getByText(/Could not save/i)).toBeTruthy())
    fireEvent.click(strict) // second save succeeds → banner clears
    await waitFor(() => expect(screen.queryByText(/Could not save/i)).toBeNull())
  })
```

- [ ] **Step 4: Add the failing "error clears on success" test — RulesEditor** — append inside `describe('RulesEditor', …)` in `src/options/RulesEditor.test.tsx`

```ts
  test('a successful save clears a prior error banner', async () => {
    const store = fakeStore({ canonical: {}, blocked: [] })
    let failNext = true
    store.save = async (patch: Partial<Ruleset>) => {
      if (failNext) {
        failNext = false
        throw new Error('quota')
      }
      store.current = { ...store.current, ...patch }
    }
    render(<RulesEditor store={store} />)
    await screen.findByText('Blocked domains')
    fireEvent.input(screen.getByPlaceholderText('add blocked domain'), { target: { value: 'a.com' } })
    fireEvent.click(screen.getByText('Block')) // fails → banner
    await waitFor(() => expect(screen.getByText(/Could not save/i)).toBeTruthy())
    fireEvent.input(screen.getByPlaceholderText('add blocked domain'), { target: { value: 'b.com' } })
    fireEvent.click(screen.getByText('Block')) // succeeds → banner clears
    await waitFor(() => expect(screen.queryByText(/Could not save/i)).toBeNull())
  })
```

- [ ] **Step 5: Run the options tests + typecheck**

Run: `npx vitest run src/options && npx tsc --noEmit`
Expected: PASS — the two new banner tests pass, and every pre-existing options test still passes (the existing OptionsView "failed save reverts the toggle" test still holds: on failure the code now reverts to `store.load()`, which for that test's fake returns the unchanged current settings, leaving the toggle reverted).

- [ ] **Step 6: Commit**

```bash
git add src/options/OptionsView.tsx src/options/RulesEditor.tsx src/options/OptionsView.test.tsx src/options/RulesEditor.test.tsx
git commit -m "fix: route options saves through optimisticSave — no stale-revert, clear banner on success"
```

---

### Task 3: RulesEditor text-edit safety (flush-on-hide + watch-guard)

**Files:**
- Modify: `src/options/RulesEditor.tsx`
- Modify: `src/options/RulesEditor.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: no exported interface. `RulesEditor` no longer overwrites a focused input from `store.watch`, and commits an unflushed edit when the tab hides.

- [ ] **Step 1: Add failing tests** — append inside `describe('RulesEditor', …)` in `src/options/RulesEditor.test.tsx`

First add a watchable fake store helper at the top of the file (after the existing `fakeStore`):

```ts
function watchableStore(initial: Ruleset): Store<Ruleset> & { current: Ruleset; emit: (r: Ruleset) => void } {
  let cb: ((r: Ruleset) => void) | null = null
  const s = {
    current: { ...initial },
    load: async () => s.current,
    save: async (patch: Partial<Ruleset>) => {
      s.current = { ...s.current, ...patch }
    },
    watch: (fn: (r: Ruleset) => void) => {
      cb = fn
      return () => {
        cb = null
      }
    },
    emit: (r: Ruleset) => cb?.(r),
  }
  return s as Store<Ruleset> & { current: Ruleset; emit: (r: Ruleset) => void }
}
```

Then the tests:

```ts
  test('a remote watch update does not clobber a focused input; it applies after blur', async () => {
    const store = watchableStore({ canonical: { 'x.com': { keepParams: ['id'] } }, blocked: [] })
    render(<RulesEditor store={store} />)
    const kp = (await screen.findByPlaceholderText('keepParams (comma-separated)')) as HTMLInputElement
    kp.focus()
    fireEvent.focusIn(kp)
    store.emit({ canonical: { 'x.com': { keepParams: ['REMOTE'] } }, blocked: [] })
    // still shows the focused value, not the remote one
    expect((screen.getByPlaceholderText('keepParams (comma-separated)') as HTMLInputElement).value).toBe('id')
    fireEvent.focusOut(kp)
    await waitFor(() =>
      expect((screen.getByPlaceholderText('keepParams (comma-separated)') as HTMLInputElement).value).toBe('REMOTE')
    )
  })

  test('visibilitychange=hidden commits an unblurred keepParams edit', async () => {
    const store = fakeStore({ canonical: { 'x.com': {} }, blocked: [] })
    render(<RulesEditor store={store} />)
    const kp = (await screen.findByPlaceholderText('keepParams (comma-separated)')) as HTMLInputElement
    kp.focus()
    fireEvent.input(kp, { target: { value: 'id' } })
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(store.current.canonical['x.com'].keepParams).toEqual(['id']))
    if (original) Object.defineProperty(document, 'visibilityState', original)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/options/RulesEditor.test.tsx`
Expected: FAIL — the watch update currently clobbers the focused input (value becomes `REMOTE` immediately), and no visibilitychange handler commits the edit.

- [ ] **Step 3: Add refs + focus-gated watch + hide-flush + container ref** — `src/options/RulesEditor.tsx`

Change the hooks import to include `useRef`:

```ts
import { useEffect, useRef, useState } from 'preact/hooks'
```

Add the refs (near the other `useState` declarations):

```ts
  const editingRef = useRef(false)
  const pendingRemoteRef = useRef<Ruleset | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
```

Replace the existing mount effect (the `useEffect` with `store.load()` + `return store.watch(setRuleset)`) with a focus-gated watch:

```ts
  useEffect(() => {
    void store.load().then((r) => {
      setRuleset(r)
      setLoaded(true)
    })
    return store.watch((r) => {
      // Don't overwrite an input the user is actively editing; buffer and apply on blur.
      if (editingRef.current) pendingRemoteRef.current = r
      else setRuleset(r)
    })
  }, [])
```

Add two more effects after it — the hide-flush and the container focus tracking:

```ts
  useEffect(() => {
    function onVisibility() {
      // Backgrounding/closing the tab: commit a pending onBlur edit before we lose it.
      if (document.visibilityState === 'hidden') (document.activeElement as HTMLElement | null)?.blur()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onIn = () => {
      editingRef.current = true
    }
    const onOut = () => {
      editingRef.current = false
      if (pendingRemoteRef.current) {
        setRuleset(pendingRemoteRef.current)
        pendingRemoteRef.current = null
      }
    }
    el.addEventListener('focusin', onIn)
    el.addEventListener('focusout', onOut)
    return () => {
      el.removeEventListener('focusin', onIn)
      el.removeEventListener('focusout', onOut)
    }
  }, [loaded])
```

Attach the container ref — change the outer wrapper from `<div class="rules-editor">` to:

```tsx
    <div class="rules-editor" ref={containerRef}>
```

- [ ] **Step 4: Run the RulesEditor tests + typecheck**

Run: `npx vitest run src/options/RulesEditor.test.tsx && npx tsc --noEmit`
Expected: PASS — the focused input keeps its value on a remote emit and updates after `focusOut`; the hidden-blur commits the edit. All prior RulesEditor tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/options/RulesEditor.tsx src/options/RulesEditor.test.tsx
git commit -m "fix: RulesEditor commits edits on tab hide and buffers remote watch updates while editing"
```

---

### Task 4: Subdomain→registrable note (warn-but-allow) + version bump

**Files:**
- Create: `src/options/domainNote.ts`
- Create: `src/options/domainNote.test.ts`
- Modify: `src/options/RulesEditor.tsx`
- Modify: `src/options/RulesEditor.test.tsx`
- Modify: `package.json`, `public/manifest.json` (version → 0.7.2)

**Interfaces:**
- Consumes: `getDomain` from `tldts` (already a dependency).
- Produces: `registrableNote(domain: string): string | null`.

- [ ] **Step 1: Write the failing helper test** — `src/options/domainNote.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { registrableNote } from './domainNote'

describe('registrableNote', () => {
  test('a subdomain returns a note naming the registrable domain', () => {
    expect(registrableNote('mail.example.com')).toBe(
      'This affects all of example.com (subdomains collapse to the registrable domain).'
    )
  })
  test('a registrable domain returns null', () => {
    expect(registrableNote('example.com')).toBeNull()
  })
  test('blank or unparseable input returns null', () => {
    expect(registrableNote('')).toBeNull()
    expect(registrableNote('   ')).toBeNull()
    expect(registrableNote('localhost')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/options/domainNote.test.ts`
Expected: FAIL — cannot resolve `./domainNote`.

- [ ] **Step 3: Implement** — `src/options/domainNote.ts`

```ts
import { getDomain } from 'tldts'

/**
 * A non-blocking note when `domain` isn't its own registrable domain — matching
 * collapses subdomains to the registrable domain (same notion isBlocked/canonicalize
 * use), so blocking/keying mail.example.com actually affects all of example.com.
 * Returns null when the input already IS its registrable domain, or won't parse.
 */
export function registrableNote(domain: string): string | null {
  const d = domain.trim()
  const reg = getDomain(d)
  return reg && reg !== d
    ? `This affects all of ${reg} (subdomains collapse to the registrable domain).`
    : null
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/options/domainNote.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the failing RulesEditor note test** — append inside `describe('RulesEditor', …)` in `src/options/RulesEditor.test.tsx`

```ts
  test('adding a subdomain shows a registrable-domain note', async () => {
    const store = fakeStore({ canonical: {}, blocked: [] })
    render(<RulesEditor store={store} />)
    await screen.findByText('Canonicalization rules')
    fireEvent.input(screen.getByPlaceholderText('add domain, e.g. news.ycombinator.com'), {
      target: { value: 'mail.example.com' },
    })
    fireEvent.click(screen.getByText('Add domain'))
    expect(await screen.findByText(/affects all of example\.com/i)).toBeTruthy()
  })
```

- [ ] **Step 6: Wire the note into RulesEditor** — `src/options/RulesEditor.tsx`

Add the import:

```ts
import { registrableNote } from './domainNote'
```

Add two note states (near the other `useState`s):

```ts
  const [canonicalNote, setCanonicalNote] = useState<string | null>(null)
  const [blockedNote, setBlockedNote] = useState<string | null>(null)
```

In the **canonical** add row: clear the note when the input changes, and set it on add. Change the domain `<input>`'s `onInput` and the "Add domain" `<button>`'s `onClick`:

```tsx
          <input
            placeholder="add domain, e.g. news.ycombinator.com"
            value={newDomain}
            onInput={(e) => {
              setNewDomain((e.target as HTMLInputElement).value)
              setCanonicalNote(null)
            }}
          />
          <button
            onClick={() => {
              const d = newDomain.trim()
              if (d) {
                void apply({ type: 'addDomain', domain: d })
                setCanonicalNote(registrableNote(d))
              }
              setNewDomain('')
            }}
          >
            Add domain
          </button>
```

and render the note right after that `.rule-add` div (still inside the canonical `<section>`):

```tsx
        {canonicalNote && <p class="hint domain-note">{canonicalNote}</p>}
```

In the **blocked** add row, mirror it — the blocked `<input>` `onInput` and the "Block" `<button>` `onClick`:

```tsx
          <input
            placeholder="add blocked domain"
            value={newBlocked}
            onInput={(e) => {
              setNewBlocked((e.target as HTMLInputElement).value)
              setBlockedNote(null)
            }}
          />
          <button
            onClick={() => {
              const d = newBlocked.trim()
              if (d) {
                void apply({ type: 'addBlocked', domain: d })
                setBlockedNote(registrableNote(d))
              }
              setNewBlocked('')
            }}
          >
            Block
          </button>
```

and the note after the blocked `.rule-add` div:

```tsx
        {blockedNote && <p class="hint domain-note">{blockedNote}</p>}
```

- [ ] **Step 7: Bump the version to 0.7.2**

In `package.json` set `"version": "0.7.2"`. In `public/manifest.json` set `"version": "0.7.2"`.

- [ ] **Step 8: Run the full suite + typecheck + build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all tests PASS (incl. the note test and every prior options test); no type errors; build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/options/domainNote.ts src/options/domainNote.test.ts src/options/RulesEditor.tsx src/options/RulesEditor.test.tsx package.json public/manifest.json
git commit -m "feat: warn when a rule domain collapses to its registrable domain; v0.7.2"
```

---

## Manual Acceptance (after all tasks)

1. **Stale-revert gone:** with a store that can reject a save, make two rapid edits where the first fails — the UI settles to the true persisted state, not a pre-edit snapshot.
2. **Banner clears:** trigger a save failure (banner shows), then make a successful edit → banner disappears.
3. **Tab-hide flush:** type into a keepParams/pathRewrite field and switch tabs (don't click away first) → the edit is persisted.
4. **Watch guard:** with the options page open in two profiles, edit a field in one while a sync arrives — your keystrokes aren't overwritten; the remote change lands after you leave the field.
5. **Subdomain note:** add `mail.example.com` (canonical or blocked) → a note says it affects all of `example.com`; the value is stored as entered.

## Self-Review

**1. Spec coverage:**
- Stale-revert race → Task 1 (helper) + Task 2 (adoption). ✓
- Error-banner-not-cleared → Task 2 (`onSuccess` clears in both components). ✓
- Tab-close unflushed edit → Task 3 (visibilitychange blur-flush). ✓
- Watch clobbers in-progress edit → Task 3 (focus-gated buffer). ✓
- Subdomain warning → Task 4 (`registrableNote` + wiring). ✓
- Version 0.7.2 → Task 4 Step 7. ✓
- Confined to `src/options` (+ version files); no matching-semantics change. ✓

**2. Placeholder scan:** No TBD/TODO; every code/test step is complete; the store-fake helpers and the visibilityState save/restore are spelled out. ✓

**3. Type consistency:** `optimisticSave<T>(deps)` signature is defined in Task 1 and used with `<Settings>`/`<Ruleset>` in Task 2 with matching `apply`/`persist`/`reload`/`onSuccess`/`onError` shapes. `registrableNote(domain): string | null` defined in Task 4 Step 3 and called in Step 6. `flashSaved` defined once in Task 2 and referenced by both `apply`/`replaceAll`. `editingRef`/`pendingRemoteRef`/`containerRef` declared in Task 3 Step 3 and used in the same task's effects/JSX. ✓

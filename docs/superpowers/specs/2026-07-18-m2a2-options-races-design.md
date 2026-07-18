# PageThreads M2a-2 — Options Edit-Races & UX

**Date:** 2026-07-18
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §9 (settings surface), §4.4 (resolver rules). Second and final chunk of **M2a** (backlog sweep). Follows **M2a-1** (SW/badge/read-marker correctness ✓). **M2a completes at merge of this chunk.**

## Goal

Fix five accumulated options-page defects — the concurrent-save stale-revert race, the error banner that never clears on a later success, tab-close loss of an unflushed rule edit, cross-profile `watch` clobbering an in-progress edit, and the missing subdomain→registrable warning — so editing settings and resolver rules is race-safe and clear. All changes are confined to `src/options`.

## Scope

In (the five items):
- **Stale-revert race** — `OptionsView.update` and `RulesEditor.apply`/`replaceAll` capture a `prev` snapshot and, on save failure, `setState(prev)`. Under two rapid edits, a rejected earlier save reverts to a snapshot that predates the later edit, silently discarding it.
- **Error banner not cleared on success** — the success path never calls `setError(null)`, so a stale error persists after a later save succeeds.
- **Tab-close unflushed edit** — `keepParams`/`pathRewrite` inputs commit only `onBlur`; closing or backgrounding the tab before blur loses the edit.
- **Watch clobbers in-progress edit** — `RulesEditor`'s `store.watch(setRuleset)` replaces the ruleset on any storage change, overwriting text the user is currently typing (e.g. a cross-profile `storage.sync` update).
- **Subdomain warning** — adding a canonical/blocked domain that isn't its own registrable domain (e.g. `mail.example.com`) silently collapses to `example.com` at match time, with no editor feedback.

Out (explicit non-goals):
- No change to matching/canonicalization semantics — the registrable-domain collapse stays as-is; we only *warn*.
- No per-row draft-state refactor (the minimal flush-on-hide + watch-guard approach is used instead).
- No change outside `src/options`; no network/sanitize/resolver/badge change.

## Design

### 1. Shared optimistic-save helper (`src/options/optimisticSave.ts` — new)

A single pure-ish async helper both components use, replacing their bespoke optimistic-then-rollback blocks:

```ts
export async function optimisticSave<T>(deps: {
  next: T
  apply: (value: T) => void       // setState — optimistic, and again on revert
  persist: (value: T) => Promise<void>
  reload: () => Promise<T>        // store.load() — the persisted source of truth
  onSuccess: () => void           // clears the error banner (+ RulesEditor: flash "Saved ✓")
  onError: (message: string) => void
}): Promise<void> {
  deps.apply(deps.next)
  try {
    await deps.persist(deps.next)
    deps.onSuccess()
  } catch {
    deps.apply(await deps.reload()) // revert to persisted truth, not a stale snapshot
    deps.onError('Could not save — try again.')
  }
}
```

Why this fixes both the race and the banner: there is no captured `prev` in-memory snapshot to go stale, so a rejected earlier save can no longer discard a later edit — on failure we re-read the store, whose serialized writes (`createStore` write-chain) hold the true, consistent state. And `onSuccess` clears the error banner. (Bound: `reload()` reflects store truth at the moment it runs; a *still-in-flight* concurrent save re-asserts its own optimistic value independently. The end state after all saves settle is store truth. This is strictly better than the current unconditional stale-snapshot revert.)

- **`OptionsView.update(patch)`** becomes:
  ```ts
  await optimisticSave<Settings>({
    next: { ...settings, ...patch },
    apply: setSettings,
    persist: () => store.save(patch),
    reload: () => store.load(),
    onSuccess: () => setError(null),
    onError: setError,
  })
  ```
- **`RulesEditor.apply(action)`** builds `next = rulesReducer(ruleset, action)` and calls `optimisticSave<Ruleset>` with `apply: setRuleset`, `persist: () => store.save(next)`, `reload: () => store.load()`, `onError: setError`, and `onSuccess` = clear error + flash "Saved ✓" (the existing `setSaved(true)` + 1.5 s timeout). **`replaceAll(next)`** (import) uses the same helper.

### 2. RulesEditor text-edit safety (`src/options/RulesEditor.tsx`)

- **Flush on hide (tab-close/switch loss):** a `useEffect` adds a `document` `visibilitychange` listener; when `document.visibilityState === 'hidden'`, it calls `(document.activeElement as HTMLElement | null)?.blur()`. Blurring the focused `keepParams`/`pathRewrite` input synchronously fires its existing `onBlur` → `apply(...)`, committing the edit before the page is backgrounded. Reuses the existing save path — no per-row draft state. (Best-effort on true unload; reliable on the common background/switch transition, which fires `visibilitychange` while the page still runs.) The listener is removed on unmount.
- **Watch guard (cross-profile clobber):** an `editingRef = useRef(false)` tracks whether an editor input is focused (set `true` on the rules-editor container's `focusin`, `false` on `focusout`), plus a `pendingRemoteRef = useRef<Ruleset | null>(null)`. The `store.watch` callback becomes: `if (editingRef.current) pendingRemoteRef.current = r; else setRuleset(r)`. On `focusout`, if `pendingRemoteRef.current` is non-null, apply it (`setRuleset`) and clear the ref. This prevents a remote storage change from overwriting keystrokes mid-edit while still landing the change once the field is left. Focus tracking uses `onFocusCapture`/`onBlurCapture` (or `focusin`/`focusout`) on the `.rules-editor` container.

### 3. Subdomain warning (`src/options/RulesEditor.tsx`, warn-but-allow)

A small pure helper in a new file `src/options/domainNote.ts`:
```ts
import { getDomain } from 'tldts'
export function registrableNote(domain: string): string | null {
  const d = domain.trim()
  const reg = getDomain(d)
  return reg && reg !== d ? `This affects all of ${reg} (subdomains collapse to the registrable domain).` : null
}
```
The "Add domain" and "Block" handlers, on a successful add, set a `domainNote` state to `registrableNote(d)`; the note renders as a non-blocking `<p class="hint domain-note">` under the relevant add row when non-null, and clears on the next add or when the input changes. The domain is still stored exactly as entered (matching's registrable collapse is unchanged).

### 4. Error-banner clear

Folded into §1: every successful save (both components, all paths incl. import) clears the banner via `onSuccess`. No separate mechanism.

## Testing

- **Unit — `optimisticSave.test.ts` (new):** success calls `apply(next)` then `onSuccess` (no reload); failure calls `apply(next)` then `apply(reloadedValue)` and `onError`; a two-call concurrent scenario where the first `persist` rejects after the second applied ends with the state equal to the reloaded store truth (not the first call's stale snapshot). Fakes for `persist`/`reload`.
- **Unit — `domainNote.test.ts` (new, for `registrableNote`):** `mail.example.com` → note mentioning `example.com`; `example.com` → `null`; bare/invalid input → `null`.
- **Component (jsdom) — `RulesEditor.test.tsx` (extend):** a prior error banner is cleared after a subsequent successful `apply`; while a rule input is focused, a `store.watch` emission does not change the rendered inputs, and applies after `focusout`; `visibilitychange=hidden` blurs the active input and commits its value (spy on the store `save`); adding `mail.example.com` shows the registrable note.
- **Component (jsdom) — `OptionsView.test.tsx` (extend):** after a failed save shows the banner, a later successful toggle clears it. Existing "failed save reverts" test updated to the reload-truth behavior (revert reflects `store.load()`), not weakened.
- All other existing options tests keep passing (updated only for the `optimisticSave` refactor).

## Acceptance

1. Two rapid edits where the first save fails no longer discards the second — the UI settles to the store's true persisted state (stale-revert gone).
2. A stale error banner clears as soon as any later save succeeds.
3. Switching away from / closing the options tab commits an unflushed `keepParams`/`pathRewrite` edit (via the hidden-blur flush).
4. A cross-profile ruleset change does not overwrite an input the user is actively editing; it applies once the field loses focus.
5. Adding `mail.example.com` (canonical or blocked) shows a non-blocking note that it affects all of `example.com`; the value is stored as entered.
6. No change outside the options page. Version 0.7.2; existing tests pass (refactor-only updates). **M2a completes at merge.**

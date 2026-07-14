# PageThreads M1d-1 — Options Page + Hardening Design

**Date:** 2026-07-14
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §7 (strict privacy), §9 (settings surface). First of two M1d chunks (**M1d-1 options + hardening** → M1d-2 per-domain rules + unread badge). M1d completes M1.

## Goal

Give the deferred settings their own UI, add the §7 strict-privacy mode as a configurable toggle (auto vs. manual resolution), and land the three M1c-deferred hardening items.

## Scope

In:
- Options page (new extension surface) with two toggles: `onNonWebPage` (hold/clear) and `resolveMode` (auto/manual).
- Strict privacy as `resolveMode: 'manual'` — the panel resolves nothing until the user clicks "Check for discussion".
- Hardening: per-tag sanitizer attribute allowlist; read-marker retry cap; topic-only `update_message` (message moved/renamed) handling.

Out (M1d-2 / later): per-domain resolver + canonicalization rules editor, unread badge, domain block-list UI, JSON import/export, notification preferences.

## Design

### Settings

`src/shared/settings.ts` `Settings` gains one field (the other already exists):

```ts
interface Settings {
  onNonWebPage: 'hold' | 'clear'   // existing (M1a)
  resolveMode: 'auto' | 'manual'   // new; default 'auto' (preserves current behavior)
}
DEFAULT_SETTINGS = { onNonWebPage: 'hold', resolveMode: 'auto' }
```

The serialized-write `createStore` and `createSettingsStore` are unchanged (the store is generic; adding a field is data-only). This is the first consumer to exercise the M1b save-race fix with two independently-written fields.

### Options page (new surface)

- `public/manifest.json` gains `"options_page": "src/options/index.html"` (opens in a tab; simpler than an embedded panel and matches the "grows later" intent).
- New Vite entry `options` (third HTML entry alongside `panel`): `src/options/index.html` + `src/options/main.tsx` + `OptionsView.tsx`. Preact, same stack; reuses `src/panel/style.css`-style rules in a small `src/options/options.css`.
- `OptionsView` loads settings via `createSettingsStore()`, renders each setting as a labeled control with a one-line explanation, and writes changes immediately via `store.save({ field: value })`. No Save button (autosave); the store's serialized writes make rapid toggles safe.
- Reachable from the panel's `AccountView` via a "Settings" button calling `chrome.runtime.openOptionsPage()`, and from `chrome://extensions`.
- Live effect: the panel already runs `settingsStore.watch` and holds `settingsRef`; a change in the options tab propagates to an open panel with no reload.

### Panel manual-resolution gate

Pure helper `src/panel/resolveGate.ts`:

```ts
// True when the panel must wait for an explicit user click before resolving.
function shouldGate(resolveMode: 'auto' | 'manual', alreadyChecked: boolean): boolean
```

App integration (thin layer over existing follow/pin logic; `panelTarget` untouched):
- New state `pendingEntity: PageEntity | null` and `checked: boolean`.
- In `applyPush`, when `action === 'switch'`: if `shouldGate(settingsRef.current.resolveMode, false)` → set `pendingEntity = entity`, clear thread/messages, do NOT call `initThread`. Else current behavior (call `initThread`).
- Render: when `pendingEntity` and not yet checked → a gate view (page title + "Check for discussion" button). Clicking sets `checked`, clears `pendingEntity`, and calls `initThread(entity)` (the exact call `applyPush` would have made).
- Switching tabs re-arms the gate (`checked` resets on a new switch). `clear` action clears `pendingEntity` too.
- Manual mode still lets the user compose? No — composing requires a resolved thread; the gate precedes resolution, so the composer stays disabled until "Check" resolves (consistent with today's `disabled={!thread}`).

Result: in manual mode, no `getStreamId`/`getTopics`/`getMessages` fires for a page until the user clicks — satisfying §7 ("nothing about a passively-browsed page reaches the realm").

### Hardening

1. **Per-tag sanitizer attributes** (`src/panel/renderMessage.ts`): replace the flat `ALLOWED_ATTR` with a DOMPurify `uponSanitizeAttribute` hook that drops attributes not valid for their element — `href`/`title` only on `a`; `datetime` only on `time`; `start` only on `ol`; `align` only on `th`/`td`; `class` on any allowed tag; `src` handled as today (images already transformed). The single-gate invariant and sanitize-then-transform structure are preserved; renderMessage.ts stays the only HTML sink. All 16 existing sanitizer tests pass unchanged; new negatives added (e.g. `<td href="x">` loses `href`; `<span datetime>` loses `datetime`).
2. **Read-marker retry cap** (`src/panel/readMarker.ts`): bound the retry queue — after `maxRetries` (default 5) consecutive failed flushes, drop the current batch and log-and-forget rather than re-queuing forever; a successful flush resets the counter. New fake-timer tests cover the cap and the reset.
3. **Topic-only `update_message`** (`src/background/index.ts` + `src/shared/messages.ts` + `src/panel/threadState.ts`/`App.tsx`): when an `update_message` event carries a topic change (`orig_subject` present / `subject` differs) the SW broadcasts `{type:'messageMoved', messageId, newTopic}`; the panel, for a message currently shown, removes it if `!topicMatchesKey(newTopic, currentThreadKey)` (moved out of this thread). Content-only edits keep the existing `messageUpdated` path. (Moves *into* the current topic still arrive via the normal message event / next history fetch — no regression.)

### Version

`0.4.0` in `package.json` + `public/manifest.json`.

## Testing

- Unit: `settings` round-trips `resolveMode` (+ both-field save via the existing race test pattern); `shouldGate` truth table; `renderMessage` per-tag negatives (href on td, datetime on span, start on ul) alongside the unchanged 16 positives; `readMarker` retry cap + reset (fake timers); `threadState`/reducer remove-on-move path.
- Component: `OptionsView` renders both toggles, reflects stored values, and writes on change (fake store); panel gate view renders the Check button in manual mode and calls resolve on click.
- Manual checklist: enable strict mode in options → open panel on a fresh page → "Check for discussion" shown, DevTools Network shows zero Zulip calls until clicked → click resolves the thread; disable → auto-resolves; toggle `onNonWebPage` live and observe panel behavior on a chrome:// tab; move a message to another topic in Zulip web → it disappears from the panel thread.

## Acceptance

1. The options page opens from the panel's ⚙️ view and from chrome://extensions, shows both toggles, and changes take effect in an open panel without reload.
2. With strict mode on, no Zulip request is made for a page until "Check for discussion" is clicked; with it off, resolution is automatic (unchanged).
3. The three hardening items are implemented with passing unit tests; the sanitizer's 16 existing tests still pass.
4. Version 0.4.0; all existing 176 tests keep passing.

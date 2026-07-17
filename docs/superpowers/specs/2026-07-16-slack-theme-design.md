# PageThreads — Slack-Style Theme Design

**Date:** 2026-07-16
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md). Standalone visual pass between M1 (complete) and M2. **Not a milestone** — a UI/theming improvement with no behavior change.

## Goal

Give the side panel and options page a polished, Slack-inspired visual identity — an **Aubergine** default theme plus a **Dark** theme that follows the OS setting with a manual override — built on CSS design tokens so the two palettes cost almost the same as one.

## Scope

In:
- A shared design-token sheet (CSS custom properties): **Aubergine (light)** on `:root`, **Dark** under `:root[data-theme="dark"]`.
- A `theme: 'system' | 'light' | 'dark'` setting (default `'system'`) on the existing settings store, an **Appearance** control on the options page, and live theme application (OS flip + setting change) on both surfaces.
- Panel restyle to the approved Aubergine mockup: aubergine header bar with `host · N messages` subtitle, rounded-square sender **avatars**, **message grouping**, bold sender + tabular timestamp, blue-tinted "your" reaction pills, and a bordered composer with a green send button.
- Options-page restyle using the same tokens.

Out (explicit non-goals):
- Composer formatting toolbar (B / i / link / @ / emoji) — **not** included (its buttons would have no behavior).
- Any behavior, data, network, or badge change. Avatars, the header count, and grouping are **presentational**, derived entirely from message data already in hand.
- New fonts as web/data-URI assets — we use Slack's own system font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`), which is what Slack falls back to anyway.

## Design

### Design tokens (`src/shared/theme.css` — new, shared)

A single stylesheet imported by both the panel and options entries. Defines `--pt-*` custom properties twice: the Aubergine palette on `:root`, and the Dark overrides under `:root[data-theme="dark"]`. All panel/options CSS colors reference these vars; no hardcoded hex remains in `style.css`/`options.css` (except inside the tokens sheet).

Token groups and values (Aubergine light / Dark):

| Token | Aubergine | Dark | Use |
| --- | --- | --- | --- |
| `--pt-header-bg` | `#3f0e40` | `#1a1d21` | header bar |
| `--pt-header-ink` | `#ffffff` | `#e9eaeb` | header text |
| `--pt-body-bg` | `#ffffff` | `#1a1d21` | message area, composer well |
| `--pt-ink` | `#1d1c1d` | `#d5d6d7` | primary text |
| `--pt-muted` | `#616061` | `#9a9b9d` | timestamps, secondary |
| `--pt-line` | `#e6e6e6` | `#34373b` | borders/dividers |
| `--pt-hover` | `#f7f6f7` | `#232629` | row/button hover |
| `--pt-accent` | `#611f69` | `#c99be0` | aubergine accent (active, mention, focus) |
| `--pt-send` | `#007a5a` | `#007a5a` | composer send button |
| `--pt-link` | `#1264a3` | `#4ea1e8` | links |
| `--pt-pill-bg` | `#f6f6f6` | `#26292d` | reaction pill |
| `--pt-mine-bg` | `#e8f5fa` | `rgba(29,155,209,.18)` | your reaction pill |
| `--pt-mine-bd` | `#1264a3` | `#2a6f97` | your reaction border |
| `--pt-mine-ink` | `#0b5394` | `#79c0e8` | your reaction text |
| `--pt-code-bg` | `#f4eef4` | `#2b2f33` | inline code |
| `--pt-code-ink` | `#772f7a` | `#e6b8e0` | inline code text |
| `--pt-mention-bg` | `#ede1f0` | `rgba(201,155,224,.16)` | @mention chip |
| `--pt-error-bg` | `#fdecea` | `#3a2422` | error banner |
| `--pt-error-ink` | `#b3261e` | `#f2b8b5` | error / danger text |
| `--pt-danger` | `#b3261e` | `#f2b8b5` | delete affordances |

The sheet also sets `:root { color-scheme: light }` and `:root[data-theme="dark"] { color-scheme: dark }` so native form controls and scrollbars match.

### Theme resolution (`src/shared/theme.ts` — new)

- `export type ThemePref = 'system' | 'light' | 'dark'`
- **Pure** `resolveEffectiveTheme(pref: ThemePref, prefersDark: boolean): 'light' | 'dark'` — `pref === 'system' ? (prefersDark ? 'dark' : 'light') : pref`. Unit-tested across all six input combinations.
- `applyTheme(root: HTMLElement, effective: 'light' | 'dark'): void` — sets/removes `data-theme="dark"` (light removes the attribute so `:root` defaults apply).
- `startThemeSync(deps: { store: SettingsStore; root: HTMLElement; mql: MediaQueryListLike }): () => void` — glue that reads the current setting + `mql.matches`, applies the resolved theme, then re-applies on **either** `store.watch(...)` (setting changed in options) **or** `mql`'s change event (OS flipped while in `system`). Returns an unsubscribe. `MediaQueryListLike = { matches: boolean; addEventListener; removeEventListener }` so it's testable with a fake.

Both `main.tsx` entries call `startThemeSync` with `document.documentElement`, a real settings store, and `window.matchMedia('(prefers-color-scheme: dark)')`. To avoid a flash of the wrong theme before the async settings load resolves, the applier runs once synchronously with `pref='system'` (OS preference) before the store's first value arrives, then corrects when it does.

### Settings (`src/shared/settings.ts`)

Add `theme: ThemePref` to `Settings` and `theme: 'system'` to `DEFAULT_SETTINGS`. Additive and backward-compatible (missing key falls back to the default via the store's merge).

### Avatars (`src/shared/avatar.ts` — new, pure)

- `avatarInitial(fullName: string): string` — first letter of the first non-empty word, uppercased; `'?'` for empty.
- `avatarColor(fullName: string): string` — deterministic pick from a fixed palette of ~8 accessible mid-tone hex colors via a simple sum-of-char-codes hash, so the same name always gets the same swatch. Unit-tested for determinism and range.

### Message grouping (`src/panel/messageGroup.ts` — new, pure)

- `startsNewGroup(prev: ZulipMessage | null, cur: ZulipMessage): boolean` — `true` if `prev` is null, the sender differs (`sender_email`), or the gap exceeds 5 minutes (`cur.timestamp - prev.timestamp > 300`). Unit-tested: first message, same-sender-within-window (group), same-sender-after-gap (new), different-sender (new).

### Panel components

- **`MessageView.tsx`** — gains a `grouped: boolean` prop. Layout becomes a two-column row (`.message`): a 36px rounded-square avatar (`avatarColor`/`avatarInitial`) and a content column. When `grouped`, the avatar and the `.meta` sender/name line are hidden (the timestamp moves to a hover-only inline slot), matching Slack's condensed follow-ups. Existing behavior — edit/delete actions, reactions, image-placeholder click, `dangerouslySetInnerHTML` through `sanitizeMessageHtml` (the single HTML gate, unchanged) — is preserved. Class names are restyled via tokens; `.reaction-chip` → pill styling with `.mine` using `--pt-mine-*`.
- **`ThreadView.tsx`** — computes `grouped` per message with `startsNewGroup(messages[i-1] ?? null, messages[i])` and passes it down. No behavioral change.
- **`App.tsx` header** — the header becomes the aubergine bar. Title stays `thread.entity.title` (or `PageThreads`); a new subtitle line shows `` `${host} · ${count} messages` `` where `host` is derived from `thread.entity.entityUri` (strip the `web:` prefix, `new URL(...).host`, guarded) and `count` is `messages.length`. Pin and settings-gear buttons restyle to inherit header ink. On mount, `App` (or `main.tsx`) starts the theme sync.

### Options page

- **`options.css`** — restyle with the shared tokens and aubergine accents; tighten spacing/typography for consistency with the panel.
- **`OptionsView.tsx`** — add an **Appearance** section: a labeled control (radio group or `<select>`) with System / Aubergine / Dark, bound to `settings.theme` through the existing settings-store update path used by the other options. Selecting a value updates the store, which `startThemeSync` observes → both the options page and any open panel re-theme live.

## Testing

- **Unit:** `resolveEffectiveTheme` (all six combos); `startThemeSync` with fake store + fake `mql` (applies on init, on setting change, on OS flip; unsubscribe stops both); `avatarInitial`/`avatarColor` (determinism, empty-name, palette range); `startsNewGroup` (four cases above); settings store round-trips `theme` with the default.
- **Component:** update `MessageView.test.tsx` (avatar present when not grouped, hidden when grouped; existing action/reaction assertions still pass), `ThreadView.test.tsx` (first message not grouped; consecutive same-sender within window grouped), `OptionsView.test.tsx` (Appearance control renders, changing it calls the store update). All other existing behavioral/component tests stay green unchanged.
- **Manual checklist:** panel shows the Aubergine theme by default; switching the OS to dark (in `system` mode) flips both panel and options live; setting Appearance = Aubergine/Dark overrides the OS and persists across reloads; avatars + grouping render for a multi-sender thread; your own reaction shows the blue "mine" pill; composer send button is green; options page matches; no console errors; existing send/edit/delete/react/read-marker/badge behaviors unchanged.

## Acceptance

1. Panel and options page render the Aubergine theme by default, using shared `--pt-*` tokens (no stray hardcoded colors outside `theme.css`).
2. Appearance = System follows the OS and flips live on OS change; Aubergine/Dark override it and persist.
3. Panel matches the approved mockup: aubergine header + `host · N messages` subtitle, rounded-square avatars, grouped follow-ups, blue "your" reaction pills, bordered composer with green send.
4. The composer formatting toolbar is **not** present; no behavior, data, network, or badge change; all prior behavioral tests pass.
5. New pure helpers (`resolveEffectiveTheme`, `avatarInitial`, `avatarColor`, `startsNewGroup`) are unit-tested; `theme` setting round-trips. Version bumped to 0.7.0.

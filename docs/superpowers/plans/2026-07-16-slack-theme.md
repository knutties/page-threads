# Slack-Style Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the side panel and options page with a Slack-inspired Aubergine theme plus an OS-following Dark theme, built on CSS design tokens, with no behavior change.

**Architecture:** A shared `theme.css` token sheet defines a light (Aubergine) palette on `:root` and a dark palette under `:root[data-theme="dark"]`. A pure resolver + a small applier (`theme.ts`) set `data-theme` on `<html>` from a new `theme` setting, reacting to both the OS `prefers-color-scheme` change and setting changes. Panel components gain presentational-only avatars, message grouping, and a header subtitle — all derived from existing message data. Every panel/options color references a `--pt-*` var.

**Tech Stack:** TypeScript (strict), Preact, Vite multi-entry, Vitest + @testing-library/preact + jsdom, chrome.storage via the existing `createStore`.

## Global Constraints

- Version bumped to **0.7.0** (`package.json` + `public/manifest.json`), verbatim.
- **No behavior, data, network, or badge change.** Avatars, header count, and grouping derive entirely from message data already in hand.
- `renderMessage.ts` (`sanitizeMessageHtml`) remains the single HTML-injection gate — do not alter the sanitize path or route message HTML around it.
- **No web/data-URI fonts.** Use the system stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
- All colors live in `src/shared/theme.css` as `--pt-*` tokens; no hardcoded hex outside that file.
- No composer formatting toolbar.
- TDD: write the failing test first for every code (non-CSS) deliverable. Commit after each task. Run `npx tsc --noEmit` and `npm test` before each commit.

---

### Task 1: Theme resolver + `theme` setting

**Files:**
- Create: `src/shared/theme.ts`
- Create: `src/shared/theme.test.ts`
- Modify: `src/shared/settings.ts`
- Test: `src/shared/settings.test.ts` (append one assertion)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ThemePref = 'system' | 'light' | 'dark'`
  - `resolveEffectiveTheme(pref: ThemePref, prefersDark: boolean): 'light' | 'dark'`
  - `Settings.theme: ThemePref`; `DEFAULT_SETTINGS.theme = 'system'`

- [ ] **Step 1: Write the failing test** — `src/shared/theme.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { resolveEffectiveTheme } from './theme'

describe('resolveEffectiveTheme', () => {
  test('system follows the OS preference', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark')
    expect(resolveEffectiveTheme('system', false)).toBe('light')
  })

  test('explicit light/dark ignore the OS preference', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light')
    expect(resolveEffectiveTheme('light', false)).toBe('light')
    expect(resolveEffectiveTheme('dark', true)).toBe('dark')
    expect(resolveEffectiveTheme('dark', false)).toBe('dark')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/shared/theme.test.ts`
Expected: FAIL — `Failed to resolve import './theme'` / `resolveEffectiveTheme is not a function`.

- [ ] **Step 3: Create `src/shared/theme.ts`**

```ts
export type ThemePref = 'system' | 'light' | 'dark'

/** Collapse the stored preference + the OS setting into the theme to actually apply. */
export function resolveEffectiveTheme(pref: ThemePref, prefersDark: boolean): 'light' | 'dark' {
  if (pref === 'system') return prefersDark ? 'dark' : 'light'
  return pref
}
```

- [ ] **Step 4: Add the setting** — edit `src/shared/settings.ts`

Add the import at the top:

```ts
import type { ThemePref } from './theme'
```

Add the field to the `Settings` interface (after `resolveMode`):

```ts
  /** Panel/options color theme. 'system' follows the OS light/dark setting. */
  theme: ThemePref
```

Add the default to `DEFAULT_SETTINGS`:

```ts
export const DEFAULT_SETTINGS: Settings = {
  onNonWebPage: 'hold',
  resolveMode: 'auto',
  theme: 'system',
}
```

- [ ] **Step 5: Append a default assertion** — add to `src/shared/settings.test.ts`

```ts
import { DEFAULT_SETTINGS } from './settings'

test('theme defaults to system', () => {
  expect(DEFAULT_SETTINGS.theme).toBe('system')
})
```

(If `DEFAULT_SETTINGS`/`test`/`expect` are already imported at the top of the file, don't duplicate the imports — just add the `test(...)` block.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/shared/theme.test.ts src/shared/settings.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/theme.ts src/shared/theme.test.ts src/shared/settings.ts src/shared/settings.test.ts
git commit -m "feat: theme preference resolver and setting"
```

---

### Task 2: Token sheet + theme applier, wired into both entries

**Files:**
- Create: `src/shared/theme.css`
- Modify: `src/shared/theme.ts` (add `applyTheme`, `startThemeSync`, `MediaQueryListLike`)
- Modify: `src/shared/theme.test.ts` (add applier tests)
- Modify: `src/panel/main.tsx`, `src/panel/index.html`, `src/options/main.tsx`

**Interfaces:**
- Consumes: `resolveEffectiveTheme`, `ThemePref` (Task 1); `SettingsStore`, `Settings`, `DEFAULT_SETTINGS`, `createSettingsStore` (`src/shared/settings.ts`).
- Produces:
  - `interface MediaQueryListLike { matches: boolean; addEventListener(t: 'change', cb: () => void): void; removeEventListener(t: 'change', cb: () => void): void }`
  - `applyTheme(root: HTMLElement, effective: 'light' | 'dark'): void`
  - `startThemeSync(deps: { store: Pick<SettingsStore, 'load' | 'watch'>; root: HTMLElement; mql: MediaQueryListLike }): () => void`
  - `src/shared/theme.css` defining all `--pt-*` tokens (see below).

- [ ] **Step 1: Write the failing tests** — append to `src/shared/theme.test.ts`

```ts
import { applyTheme, startThemeSync, type ThemePref } from './theme'
import { DEFAULT_SETTINGS, type Settings } from './settings'

function fakeRoot() {
  const attrs: Record<string, string> = {}
  return {
    setAttribute: (k: string, v: string) => { attrs[k] = v },
    removeAttribute: (k: string) => { delete attrs[k] },
    get dataTheme() { return attrs['data-theme'] },
  }
}

function fakeStore(initial: ThemePref) {
  let cb: ((s: Settings) => void) | null = null
  return {
    load: async () => ({ ...DEFAULT_SETTINGS, theme: initial }),
    watch: (c: (s: Settings) => void) => { cb = c; return () => { cb = null } },
    fire: (t: ThemePref) => cb?.({ ...DEFAULT_SETTINGS, theme: t }),
  }
}

function fakeMql(matches: boolean) {
  let cb: (() => void) | null = null
  return {
    matches,
    addEventListener: (_t: 'change', c: () => void) => { cb = c },
    removeEventListener: () => { cb = null },
    fire(next: boolean) { this.matches = next; cb?.() },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('applyTheme', () => {
  test('dark sets the attribute, light removes it', () => {
    const root = fakeRoot()
    applyTheme(root as unknown as HTMLElement, 'dark')
    expect(root.dataTheme).toBe('dark')
    applyTheme(root as unknown as HTMLElement, 'light')
    expect(root.dataTheme).toBeUndefined()
  })
})

describe('startThemeSync', () => {
  test('paints from the OS preference synchronously before the store loads', () => {
    const root = fakeRoot()
    const mql = fakeMql(true) // OS = dark
    startThemeSync({ store: fakeStore('system') as never, root: root as unknown as HTMLElement, mql })
    expect(root.dataTheme).toBe('dark') // system + OS dark, before load resolves
  })

  test('applies the stored preference once it loads (overrides OS)', async () => {
    const root = fakeRoot()
    const mql = fakeMql(true) // OS = dark
    startThemeSync({ store: fakeStore('light') as never, root: root as unknown as HTMLElement, mql })
    await flush()
    expect(root.dataTheme).toBeUndefined() // explicit light beats OS dark
  })

  test('repaints when the OS flips while in system mode', async () => {
    const root = fakeRoot()
    const mql = fakeMql(false) // OS = light
    startThemeSync({ store: fakeStore('system') as never, root: root as unknown as HTMLElement, mql })
    await flush()
    expect(root.dataTheme).toBeUndefined()
    mql.fire(true)
    expect(root.dataTheme).toBe('dark')
  })

  test('repaints when the setting changes', async () => {
    const root = fakeRoot()
    const mql = fakeMql(false)
    const store = fakeStore('system')
    startThemeSync({ store: store as never, root: root as unknown as HTMLElement, mql })
    await flush()
    store.fire('dark')
    expect(root.dataTheme).toBe('dark')
  })

  test('unsubscribe stops reacting to OS flips', async () => {
    const root = fakeRoot()
    const mql = fakeMql(false)
    const stop = startThemeSync({ store: fakeStore('system') as never, root: root as unknown as HTMLElement, mql })
    await flush()
    stop()
    mql.fire(true)
    expect(root.dataTheme).toBeUndefined() // listener removed
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/shared/theme.test.ts`
Expected: FAIL — `applyTheme`/`startThemeSync` are not exported.

- [ ] **Step 3: Implement the applier** — append to `src/shared/theme.ts`

```ts
import type { SettingsStore } from './settings'

export interface MediaQueryListLike {
  matches: boolean
  addEventListener(type: 'change', cb: () => void): void
  removeEventListener(type: 'change', cb: () => void): void
}

export function applyTheme(root: HTMLElement, effective: 'light' | 'dark'): void {
  if (effective === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
}

/**
 * Keep <html data-theme> in sync with the theme setting and the OS preference.
 * Paints once synchronously (from the OS preference) to avoid a flash before the
 * async settings load resolves, then corrects. Returns an unsubscribe.
 */
export function startThemeSync(deps: {
  store: Pick<SettingsStore, 'load' | 'watch'>
  root: HTMLElement
  mql: MediaQueryListLike
}): () => void {
  let pref: ThemePref = 'system'
  const paint = () => applyTheme(deps.root, resolveEffectiveTheme(pref, deps.mql.matches))
  paint()
  const onMql = () => paint()
  deps.mql.addEventListener('change', onMql)
  const unwatch = deps.store.watch((s) => {
    pref = s.theme
    paint()
  })
  void deps.store.load().then((s) => {
    pref = s.theme
    paint()
  })
  return () => {
    deps.mql.removeEventListener('change', onMql)
    unwatch()
  }
}
```

- [ ] **Step 4: Create the token sheet** — `src/shared/theme.css`

```css
/* PageThreads design tokens — Aubergine (light) default + Dark override.
   Every panel/options color references a --pt-* var; no hardcoded hex lives
   outside this file. */
:root {
  color-scheme: light;
  --pt-header-bg: #3f0e40;
  --pt-header-ink: #ffffff;
  --pt-body-bg: #ffffff;
  --pt-ink: #1d1c1d;
  --pt-muted: #616061;
  --pt-line: #e6e6e6;
  --pt-hover: #f7f6f7;
  --pt-accent: #611f69;
  --pt-send: #007a5a;
  --pt-link: #1264a3;
  --pt-pill-bg: #f6f6f6;
  --pt-mine-bg: #e8f5fa;
  --pt-mine-bd: #1264a3;
  --pt-mine-ink: #0b5394;
  --pt-code-bg: #f4eef4;
  --pt-code-ink: #772f7a;
  --pt-mention-bg: #ede1f0;
  --pt-error-bg: #fdecea;
  --pt-error-ink: #b3261e;
  --pt-danger: #b3261e;
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --pt-header-bg: #1a1d21;
  --pt-header-ink: #e9eaeb;
  --pt-body-bg: #1a1d21;
  --pt-ink: #d5d6d7;
  --pt-muted: #9a9b9d;
  --pt-line: #34373b;
  --pt-hover: #232629;
  --pt-accent: #c99be0;
  --pt-send: #007a5a;
  --pt-link: #4ea1e8;
  --pt-pill-bg: #26292d;
  --pt-mine-bg: rgba(29, 155, 209, 0.18);
  --pt-mine-bd: #2a6f97;
  --pt-mine-ink: #79c0e8;
  --pt-code-bg: #2b2f33;
  --pt-code-ink: #e6b8e0;
  --pt-mention-bg: rgba(201, 155, 224, 0.16);
  --pt-error-bg: #3a2422;
  --pt-error-ink: #f2b8b5;
  --pt-danger: #f2b8b5;
}
```

- [ ] **Step 5: Wire both entries**

Replace `src/panel/main.tsx` with:

```tsx
import { render } from 'preact'
import '../shared/theme.css'
import './style.css'
import { createSettingsStore } from '../shared/settings'
import { startThemeSync } from '../shared/theme'
import { App } from './App'

startThemeSync({
  store: createSettingsStore(),
  root: document.documentElement,
  mql: window.matchMedia('(prefers-color-scheme: dark)'),
})

render(<App />, document.getElementById('root')!)
```

Remove the stylesheet link from `src/panel/index.html` (style is now imported in `main.tsx`) so the head is:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>PageThreads</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

Replace `src/options/main.tsx` with:

```tsx
import { render } from 'preact'
import '../shared/theme.css'
import './options.css'
import { createSettingsStore } from '../shared/settings'
import { startThemeSync } from '../shared/theme'
import { OptionsView } from './OptionsView'

startThemeSync({
  store: createSettingsStore(),
  root: document.documentElement,
  mql: window.matchMedia('(prefers-color-scheme: dark)'),
})

render(<OptionsView />, document.getElementById('root')!)
```

- [ ] **Step 6: Run tests, typecheck, and build**

Run: `npx vitest run src/shared/theme.test.ts && npx tsc --noEmit && npm run build`
Expected: tests PASS, no type errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/shared/theme.ts src/shared/theme.css src/shared/theme.test.ts src/panel/main.tsx src/panel/index.html src/options/main.tsx
git commit -m "feat: theme token sheet and live theme applier wired into panel + options"
```

---

### Task 3: Avatar helpers

**Files:**
- Create: `src/shared/avatar.ts`
- Create: `src/shared/avatar.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `avatarInitial(fullName: string): string`; `avatarColor(fullName: string): string` (a hex from a fixed 8-color palette, deterministic per name).

- [ ] **Step 1: Write the failing test** — `src/shared/avatar.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { avatarColor, avatarInitial } from './avatar'

describe('avatarInitial', () => {
  test('uppercases the first letter of the first word', () => {
    expect(avatarInitial('Ada Lovelace')).toBe('A')
    expect(avatarInitial('  ravi kumar')).toBe('R')
  })
  test('empty or blank name falls back to ?', () => {
    expect(avatarInitial('')).toBe('?')
    expect(avatarInitial('   ')).toBe('?')
  })
})

describe('avatarColor', () => {
  test('is deterministic for the same name', () => {
    expect(avatarColor('Ada Lovelace')).toBe(avatarColor('Ada Lovelace'))
  })
  test('returns a hex from the palette', () => {
    expect(avatarColor('Ravi Kumar')).toMatch(/^#[0-9a-f]{6}$/)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/shared/avatar.test.ts`
Expected: FAIL — cannot resolve `./avatar`.

- [ ] **Step 3: Implement** — `src/shared/avatar.ts`

```ts
// Mid-tone swatches that read on both light and dark grounds with white initials.
const AVATAR_COLORS = [
  '#4a8a3f', '#3f6db5', '#b5643f', '#8a4b9c',
  '#2f8f8a', '#b53f6b', '#9c8a2f', '#5a5f8a',
]

export function avatarInitial(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? ''
  return first ? first[0]!.toUpperCase() : '?'
}

export function avatarColor(fullName: string): string {
  let sum = 0
  for (const ch of fullName) sum += ch.codePointAt(0) ?? 0
  return AVATAR_COLORS[sum % AVATAR_COLORS.length]!
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/shared/avatar.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/avatar.ts src/shared/avatar.test.ts
git commit -m "feat: deterministic avatar initial and color helpers"
```

---

### Task 4: Message-grouping predicate

**Files:**
- Create: `src/panel/messageGroup.ts`
- Create: `src/panel/messageGroup.test.ts`

**Interfaces:**
- Consumes: `ZulipMessage` (`src/shared/zulipClient.ts`).
- Produces: `GROUP_GAP_SECONDS = 300`; `startsNewGroup(prev: ZulipMessage | null, cur: ZulipMessage): boolean`.

- [ ] **Step 1: Write the failing test** — `src/panel/messageGroup.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { startsNewGroup } from './messageGroup'

function m(over: Partial<ZulipMessage>): ZulipMessage {
  return {
    id: 1, sender_full_name: 'Ada', sender_email: 'ada@x.com',
    content: '<p>x</p>', timestamp: 1000, subject: 'T · k', ...over,
  }
}

describe('startsNewGroup', () => {
  test('the first message always starts a group', () => {
    expect(startsNewGroup(null, m({}))).toBe(true)
  })
  test('a different sender starts a group', () => {
    expect(startsNewGroup(m({ sender_email: 'ada@x.com' }), m({ sender_email: 'bo@x.com' }))).toBe(true)
  })
  test('same sender within 5 minutes groups', () => {
    expect(startsNewGroup(m({ timestamp: 1000 }), m({ timestamp: 1000 + 200 }))).toBe(false)
  })
  test('same sender after more than 5 minutes starts a group', () => {
    expect(startsNewGroup(m({ timestamp: 1000 }), m({ timestamp: 1000 + 301 }))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/panel/messageGroup.test.ts`
Expected: FAIL — cannot resolve `./messageGroup`.

- [ ] **Step 3: Implement** — `src/panel/messageGroup.ts`

```ts
import type { ZulipMessage } from '../shared/zulipClient'

export const GROUP_GAP_SECONDS = 300

/** True when `cur` should start a fresh avatar/name block rather than join `prev`'s. */
export function startsNewGroup(prev: ZulipMessage | null, cur: ZulipMessage): boolean {
  if (!prev) return true
  if (prev.sender_email !== cur.sender_email) return true
  return cur.timestamp - prev.timestamp > GROUP_GAP_SECONDS
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/panel/messageGroup.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/messageGroup.ts src/panel/messageGroup.test.ts
git commit -m "feat: message-grouping predicate"
```

---

### Task 5: Avatars + grouping in MessageView / ThreadView

**Files:**
- Modify: `src/panel/MessageView.tsx`
- Modify: `src/panel/ThreadView.tsx`
- Test: `src/panel/MessageView.test.tsx`, `src/panel/ThreadView.test.tsx`

**Interfaces:**
- Consumes: `avatarInitial`, `avatarColor` (Task 3); `startsNewGroup` (Task 4).
- Produces: `MessageView` gains an optional `grouped?: boolean` prop (default `false`); DOM adds `.avatar` and `.message-main`, and `<li>` gets class `message` (plus `grouped` when grouped). `ThreadView` computes `grouped` per row.

Note: preserve every existing class used by tests — `.msg-actions`, `.reaction-chip`, `.reactions`, `.quick-reactions`, `.img-placeholder`, and the inline editor — and keep the `sanitizeMessageHtml` body render untouched.

- [ ] **Step 1: Add failing MessageView tests** — append to `src/panel/MessageView.test.tsx`

```ts
  test('shows an avatar with the sender initial when not grouped', () => {
    const { container } = renderMsg({ message: msg({ sender_full_name: 'Ada' }), grouped: false })
    const av = container.querySelector('.avatar') as HTMLElement
    expect(av).toBeTruthy()
    expect(av.textContent).toBe('A')
    expect(container.querySelector('.sender')?.textContent).toBe('Ada')
  })

  test('grouped message hides the avatar initial and the sender name', () => {
    const { container } = renderMsg({ message: msg({ sender_full_name: 'Ada' }), grouped: true })
    expect((container.querySelector('.avatar') as HTMLElement).textContent).toBe('')
    expect(container.querySelector('.sender')).toBeNull()
  })
```

- [ ] **Step 2: Run them, verify they fail**

Run: `npx vitest run src/panel/MessageView.test.tsx`
Expected: FAIL — no `.avatar`; `grouped` prop unknown.

- [ ] **Step 3: Update `MessageView.tsx`**

Add imports at the top:

```tsx
import { avatarColor, avatarInitial } from '../shared/avatar'
```

Add `grouped` to the destructured props (with a default) and its type. In the props type block add:

```tsx
  grouped?: boolean
```

Change the destructuring line to include it:

```tsx
  onToggleReaction,
  grouped = false,
}: {
```

Replace the returned JSX (the `return ( <li class="message"> … </li> )` block) with:

```tsx
  return (
    <li class={grouped ? 'message grouped' : 'message'}>
      <div class="avatar" aria-hidden="true" style={grouped ? undefined : { background: avatarColor(message.sender_full_name) }}>
        {grouped ? '' : avatarInitial(message.sender_full_name)}
      </div>
      <div class="message-main">
        <div class="meta">
          {!grouped && <span class="sender">{message.sender_full_name}</span>}
          <span class="time">
            {new Date(message.timestamp * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
          {own && !edit && (
            <span class="msg-actions">
              <button title="Edit" disabled={busy} onClick={onStartEdit}>
                ✎
              </button>
              {confirmingDelete ? (
                <button title="Confirm delete" class="danger" disabled={busy} onClick={onDelete}>
                  Delete?
                </button>
              ) : (
                <button title="Delete" disabled={busy} onClick={() => setConfirmingDelete(true)}>
                  🗑
                </button>
              )}
            </span>
          )}
        </div>
        {edit ? (
          <div class="msg-editor">
            <textarea value={editText} onInput={(e) => setEditText((e.target as HTMLTextAreaElement).value)} />
            <div>
              <button disabled={busy || !editText.trim()} onClick={() => onSaveEdit(editText)}>
                Save
              </button>
              <button disabled={busy} onClick={onCancelEdit}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            class="body zulip-rendered"
            onClick={onBodyClick}
            dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(message.content, realmUrl) }}
          />
        )}
        <div class="reactions">
          {groups.map((g) => (
            <button
              key={`${g.reaction.reaction_type}:${g.reaction.emoji_code}`}
              class={g.mine ? 'reaction-chip mine' : 'reaction-chip'}
              disabled={busy}
              onClick={() =>
                onToggleReaction({
                  emoji_name: g.reaction.emoji_name,
                  emoji_code: g.reaction.emoji_code,
                  reaction_type: g.reaction.reaction_type,
                })
              }
            >
              {emojiFromCode(g.reaction.emoji_code)} {g.count}
            </button>
          ))}
          <button title="Add reaction" class="reaction-add" disabled={busy} onClick={() => setPicking(!picking)}>
            +
          </button>
          {picking && (
            <span class="quick-reactions">
              {QUICK_REACTIONS.map((q) => (
                <button
                  key={q.emoji_code}
                  disabled={busy}
                  onClick={() => {
                    setPicking(false)
                    onToggleReaction({ emoji_name: q.emoji_name, emoji_code: q.emoji_code, reaction_type: 'unicode_emoji' })
                  }}
                >
                  {q.rendered}
                </button>
              ))}
            </span>
          )}
        </div>
      </div>
    </li>
  )
```

- [ ] **Step 4: Add a failing ThreadView test** — append to `src/panel/ThreadView.test.tsx`

```ts
  test('first message is not grouped; a same-sender follow-up within the window is', () => {
    const { container } = renderThread({
      messages: [msg(1, '<p>a</p>'), msg(2, '<p>b</p>')], // same sender + timestamp
      hasThread: true,
      threadKey: 'k1',
    })
    const rows = container.querySelectorAll('.message')
    expect(rows[0].classList.contains('grouped')).toBe(false)
    expect(rows[1].classList.contains('grouped')).toBe(true)
  })
```

- [ ] **Step 5: Run it, verify it fails**

Run: `npx vitest run src/panel/ThreadView.test.tsx`
Expected: FAIL — the second row has no `grouped` class yet.

- [ ] **Step 6: Update `ThreadView.tsx`**

Add the import:

```tsx
import { startsNewGroup } from './messageGroup'
```

Change the `messages.map` to pass `grouped`:

```tsx
      {messages.map((m, i) => (
        <MessageView
          key={m.id}
          message={m}
          grouped={!startsNewGroup(messages[i - 1] ?? null, m)}
          own={m.sender_email === ownEmail}
          realmUrl={realmUrl}
          ownUserId={ownUserId}
          edit={editState?.id === m.id ? { raw: editState.raw } : null}
          busy={busy}
          onStartEdit={() => onStartEdit(m.id)}
          onCancelEdit={onCancelEdit}
          onSaveEdit={(content) => onSaveEdit(m.id, content)}
          onDelete={() => onDelete(m.id)}
          onToggleReaction={(r) => onToggleReaction(m.id, r)}
        />
      ))}
```

- [ ] **Step 7: Run the full panel test suite + typecheck**

Run: `npx vitest run src/panel && npx tsc --noEmit`
Expected: PASS (including the pre-existing MessageView/ThreadView tests — `.msg-actions` count, reactions, editor, sanitized HTML all unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/panel/MessageView.tsx src/panel/MessageView.test.tsx src/panel/ThreadView.tsx src/panel/ThreadView.test.tsx
git commit -m "feat: sender avatars and message grouping in the thread"
```

---

### Task 6: Header subtitle (host · N messages)

**Files:**
- Create: `src/panel/headerSubtitle.ts`
- Create: `src/panel/headerSubtitle.test.ts`
- Modify: `src/panel/App.tsx` (header block only, around lines 434–446)

**Interfaces:**
- Consumes: nothing.
- Produces: `headerSubtitle(entityUri: string, count: number): string`.

- [ ] **Step 1: Write the failing test** — `src/panel/headerSubtitle.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { headerSubtitle } from './headerSubtitle'

describe('headerSubtitle', () => {
  test('shows host and pluralized message count', () => {
    expect(headerSubtitle('web:https://www.rediff.com/cricket/x.htm', 5)).toBe('www.rediff.com · 5 messages')
    expect(headerSubtitle('web:https://example.com/a', 1)).toBe('example.com · 1 message')
  })
  test('falls back to just the count when the URI has no parseable host', () => {
    expect(headerSubtitle('web:not a url', 3)).toBe('3 messages')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/panel/headerSubtitle.test.ts`
Expected: FAIL — cannot resolve `./headerSubtitle`.

- [ ] **Step 3: Implement** — `src/panel/headerSubtitle.ts`

```ts
/** "host · N messages" for the panel header; drops the host if the URI won't parse. */
export function headerSubtitle(entityUri: string, count: number): string {
  let host = ''
  try {
    host = new URL(entityUri.replace(/^web:/, '')).host
  } catch {
    host = ''
  }
  const msgs = `${count} message${count === 1 ? '' : 's'}`
  return host ? `${host} · ${msgs}` : msgs
}
```

- [ ] **Step 4: Wire it into the header** — edit `src/panel/App.tsx`

Add the import near the other panel imports (e.g. below the `MessageView` import):

```tsx
import { headerSubtitle } from './headerSubtitle'
```

Replace the header block (currently the `<header title={thread?.entity.entityUri}> … </header>`) with:

```tsx
      <header title={thread?.entity.entityUri}>
        <div class="header-text">
          <span class="title">{thread ? thread.entity.title : 'PageThreads'}</span>
          {thread && <span class="subtitle">{headerSubtitle(thread.entity.entityUri, messages.length)}</span>}
        </div>
        <button
          class={pinned ? 'pin pinned' : 'pin'}
          title={pinned ? 'Unpin: follow the active tab' : 'Pin: keep this thread while browsing'}
          onClick={togglePin}
        >
          📌
        </button>
        <button class="pin" title="Account" onClick={() => setShowAccount(true)}>
          ⚙️
        </button>
      </header>
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/panel/headerSubtitle.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors (`messages` and `thread` are already in scope in `App`).

- [ ] **Step 6: Commit**

```bash
git add src/panel/headerSubtitle.ts src/panel/headerSubtitle.test.ts src/panel/App.tsx
git commit -m "feat: header subtitle with host and message count"
```

---

### Task 7: Panel CSS restyle (tokens + Slack look)

**Files:**
- Modify: `src/panel/style.css` (full replacement)

**Interfaces:**
- Consumes: `--pt-*` tokens (Task 2); the DOM classes `.header-text`/`.subtitle` (Task 6), `.avatar`/`.message`/`.message.grouped`/`.message-main` (Task 5).
- Produces: no code interface. This is a visual deliverable — verified by build + the whole test suite staying green + the manual checklist.

- [ ] **Step 1: Replace `src/panel/style.css` entirely**

```css
:root {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--pt-body-bg); color: var(--pt-ink); }
button { font-family: inherit; }

.app { display: flex; flex-direction: column; height: 100vh; background: var(--pt-body-bg); }

/* header bar */
header {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 13px;
  background: var(--pt-header-bg); color: var(--pt-header-ink);
  white-space: nowrap;
}
header .header-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
header .title { font-weight: 800; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header .subtitle { font-size: 12px; opacity: 0.72; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pin { border: none; background: none; cursor: pointer; color: inherit; opacity: 0.6; font-size: 14px; padding: 2px; line-height: 1; }
.pin:hover { opacity: 0.9; }
.pin.pinned { opacity: 1; }

/* error banner */
.error {
  display: flex; align-items: center; gap: 8px;
  background: var(--pt-error-bg); color: var(--pt-error-ink);
  padding: 8px 12px; cursor: pointer;
}
.error > span { flex: 1; }
.error .retry { flex: none; }

.empty { flex: 1; display: grid; place-items: center; color: var(--pt-muted); padding: 16px; text-align: center; }

/* messages */
.messages { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 8px 0; background: var(--pt-body-bg); }
.message { display: grid; grid-template-columns: 36px 1fr; gap: 9px; padding: 4px 14px; }
.message:hover { background: var(--pt-hover); }
.message.grouped { padding-top: 1px; padding-bottom: 1px; }
.avatar { width: 36px; height: 36px; border-radius: 7px; display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 14px; }
.message.grouped .avatar { visibility: hidden; height: 0; }
.message-main { min-width: 0; }
.meta { display: flex; gap: 7px; align-items: baseline; }
.sender { font-weight: 800; font-size: 15px; color: var(--pt-ink); }
.time { color: var(--pt-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.message.grouped .meta .time { visibility: hidden; }
.message.grouped:hover .meta .time { visibility: visible; }
.body { font-size: 15px; line-height: 1.46; }
.body p { margin: 2px 0; overflow-wrap: anywhere; }

/* composer */
.composer { display: flex; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--pt-line); background: var(--pt-body-bg); align-items: flex-end; }
.composer textarea {
  flex: 1; resize: none; height: 60px; padding: 8px 10px; font: inherit;
  color: var(--pt-ink); background: var(--pt-body-bg);
  border: 1px solid var(--pt-line); border-radius: 9px;
}
.composer textarea:focus { outline: none; border-color: var(--pt-accent); box-shadow: 0 0 0 1px var(--pt-accent); }
.composer button {
  align-self: flex-end; padding: 8px 14px; border: none; border-radius: 7px;
  background: var(--pt-send); color: #fff; font-weight: 700; cursor: pointer;
}
.composer button:disabled { opacity: 0.5; cursor: default; }

/* message actions / editor */
.msg-actions { margin-left: auto; display: inline-flex; gap: 4px; }
.msg-actions button { border: none; background: none; cursor: pointer; opacity: 0.5; padding: 0 2px; color: var(--pt-ink); }
.msg-actions button:hover { opacity: 1; }
.msg-actions .danger { color: var(--pt-danger); opacity: 1; }
.msg-editor textarea { width: 100%; min-height: 60px; font: inherit; padding: 6px; color: var(--pt-ink); background: var(--pt-body-bg); border: 1px solid var(--pt-line); border-radius: 8px; }
.msg-editor button { margin-right: 6px; margin-top: 6px; }

/* reactions */
.reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; align-items: center; }
.reaction-chip { border: 1px solid var(--pt-line); border-radius: 12px; background: var(--pt-pill-bg); color: var(--pt-ink); padding: 1px 8px; cursor: pointer; font-size: 12px; }
.reaction-chip.mine { border-color: var(--pt-mine-bd); background: var(--pt-mine-bg); color: var(--pt-mine-ink); }
.reaction-add { border: none; background: none; cursor: pointer; opacity: 0.4; color: var(--pt-ink); }
.reaction-add:hover { opacity: 1; }
.quick-reactions { display: inline-flex; gap: 2px; }
.quick-reactions button { border: none; background: none; cursor: pointer; font-size: 16px; }

/* images + rendered zulip html */
.img-placeholder { border: 1px dashed var(--pt-line); background: var(--pt-pill-bg); padding: 8px 12px; cursor: pointer; color: var(--pt-muted); border-radius: 6px; }
.loaded-image { max-width: 100%; }
.zulip-rendered a { color: var(--pt-link); }
.zulip-rendered blockquote { border-left: 3px solid var(--pt-line); margin: 4px 0; padding-left: 8px; color: var(--pt-muted); }
.zulip-rendered pre { background: var(--pt-code-bg); padding: 6px; overflow-x: auto; border-radius: 6px; }
.zulip-rendered code { background: var(--pt-code-bg); color: var(--pt-code-ink); font-family: ui-monospace, monospace; font-size: 12px; padding: 1px 4px; border-radius: 4px; }
.zulip-rendered .user-mention { background: var(--pt-mention-bg); color: var(--pt-accent); border-radius: 3px; padding: 0 2px; }
.zulip-rendered table { border-collapse: collapse; }
.zulip-rendered th, .zulip-rendered td { border: 1px solid var(--pt-line); padding: 2px 6px; }

/* setup / account / gate */
.setup { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
.setup h2 { margin: 0; }
.setup p { margin: 0; color: var(--pt-muted); }
.setup label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; font-size: 13px; }
.setup input { padding: 6px; font-size: 14px; border: 1px solid var(--pt-line); border-radius: 6px; background: var(--pt-body-bg); color: var(--pt-ink); }
.setup small { font-weight: 400; color: var(--pt-muted); }
.tabs { display: flex; gap: 4px; }
.tab { padding: 4px 10px; border: 1px solid var(--pt-line); background: var(--pt-pill-bg); color: var(--pt-ink); cursor: pointer; border-radius: 6px 6px 0 0; }
.tab.active { background: var(--pt-body-bg); border-bottom-color: var(--pt-body-bg); font-weight: 600; }
.linkish { border: none; background: none; color: var(--pt-link); cursor: pointer; padding: 0; }
.account { display: flex; flex-direction: column; gap: 12px; padding: 0 0 16px; }
.account dl { margin: 0; padding: 0 16px; }
.account dt { font-weight: 600; font-size: 12px; color: var(--pt-muted); margin-top: 8px; }
.account dd { margin: 0; }
.account .danger { margin: 0 16px; color: var(--pt-danger); }
.gate { flex: 1; display: flex; flex-direction: column; gap: 10px; align-items: center; justify-content: center; padding: 24px; text-align: center; }
.gate-title { font-weight: 600; overflow-wrap: anywhere; }
.gate .hint { color: var(--pt-muted); font-size: 12px; }
```

- [ ] **Step 2: Build + full test suite + typecheck**

Run: `npm run build && npx vitest run && npx tsc --noEmit`
Expected: build succeeds; all tests PASS (CSS changes touch no assertions); no type errors.

- [ ] **Step 3: Manual visual check**

Reload the extension (`chrome://extensions` → ⟳) and open the panel on a threaded page. Confirm: aubergine header bar with title + `host · N messages`; avatars with initials; grouped follow-ups; blue "your" reaction pill; green Send button. Toggle OS dark mode → panel follows.

- [ ] **Step 4: Commit**

```bash
git add src/panel/style.css
git commit -m "style: Slack-inspired Aubergine/Dark panel via design tokens"
```

---

### Task 8: Options page restyle + Appearance control + version bump

**Files:**
- Modify: `src/options/options.css` (full replacement)
- Modify: `src/options/OptionsView.tsx` (add Appearance section)
- Test: `src/options/OptionsView.test.tsx` (add Appearance test; fix one typed fixture)
- Modify: `package.json`, `public/manifest.json` (version → 0.7.0)

**Interfaces:**
- Consumes: `--pt-*` tokens (Task 2); `ThemePref` (Task 1); the existing `update(patch)` path in `OptionsView`.
- Produces: an Appearance `<select>` bound to `settings.theme`.

- [ ] **Step 1: Add a failing Appearance test** — edit `src/options/OptionsView.test.tsx`

First, fix the one typed fixture that now needs `theme` (the `fakeStore({...})` call in the "reflects stored values" test):

```ts
    render(
      <OptionsView store={fakeStore({ onNonWebPage: 'clear', resolveMode: 'manual', theme: 'system' })} rulesStore={fakeRulesStore()} />
    )
```

Then append this test inside the `describe('OptionsView', …)` block:

```ts
  test('changing Appearance writes the theme setting', async () => {
    const store = fakeStore()
    render(<OptionsView store={store} rulesStore={fakeRulesStore()} />)
    const select = (await screen.findByLabelText(/Appearance/i)) as HTMLSelectElement
    expect(select.value).toBe('system')
    fireEvent.change(select, { target: { value: 'dark' } })
    await waitFor(() => expect(store.current.theme).toBe('dark'))
  })
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/options/OptionsView.test.tsx`
Expected: FAIL — no control labeled "Appearance".

- [ ] **Step 3: Add the Appearance section** — edit `src/options/OptionsView.tsx`

Add the import:

```tsx
import type { ThemePref } from '../shared/theme'
```

Insert this `<section>` immediately after the opening `<h1>…</h1>` / error line, before the Strict-privacy section:

```tsx
      <section>
        <label class="appearance">
          <span>Appearance</span>
          <select
            value={settings.theme}
            onChange={(e) => void update({ theme: (e.target as HTMLSelectElement).value as ThemePref })}
          >
            <option value="system">System (match my device)</option>
            <option value="light">Aubergine (light)</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <p class="hint">Sets the panel and settings theme. “System” follows your device’s light/dark setting.</p>
      </section>
```

- [ ] **Step 4: Replace `src/options/options.css` entirely**

```css
:root {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--pt-body-bg); color: var(--pt-ink); }
button { font-family: inherit; }

.options { max-width: 640px; margin: 24px auto; padding: 0 16px; }
.options h1 { font-size: 20px; font-weight: 800; }
.options .error { background: var(--pt-error-bg); color: var(--pt-error-ink); padding: 8px 12px; margin: 8px 0; cursor: pointer; border-radius: 6px; }
.options section { margin: 20px 0; padding-bottom: 18px; border-bottom: 1px solid var(--pt-line); }
.options label { display: flex; gap: 8px; align-items: flex-start; font-weight: 600; }
.options .hint { margin: 4px 0 0 24px; color: var(--pt-muted); font-weight: 400; }
.loading { padding: 24px; color: var(--pt-muted); }

/* appearance */
.appearance { flex-direction: column; gap: 6px; }
.appearance > span { font-weight: 700; }
.appearance select {
  padding: 6px 8px; font: inherit; color: var(--pt-ink); background: var(--pt-body-bg);
  border: 1px solid var(--pt-line); border-radius: 6px; max-width: 260px;
}

.rules-editor section { margin: 24px 0; }
.rules-editor h2 { font-size: 16px; margin-bottom: 4px; }
.rule-row, .blocked-row, .rule-add, .io { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
.rule-row input { flex: 1 1 140px; padding: 4px 6px; border: 1px solid var(--pt-line); border-radius: 6px; background: var(--pt-body-bg); color: var(--pt-ink); }
.rule-row input[readonly] { background: var(--pt-hover); }
.blocked-row span { flex: 1; }
.io textarea { flex: 1 1 100%; font-family: ui-monospace, monospace; font-size: 12px; border: 1px solid var(--pt-line); border-radius: 6px; background: var(--pt-body-bg); color: var(--pt-ink); }
.rules-editor .error { background: var(--pt-error-bg); color: var(--pt-error-ink); padding: 8px 12px; cursor: pointer; border-radius: 6px; }
.rules-editor .saved { color: var(--pt-send); font-size: 13px; margin: 4px 0; }
```

- [ ] **Step 5: Bump the version to 0.7.0**

In `package.json` set `"version": "0.7.0"`. In `public/manifest.json` set `"version": "0.7.0"`.

- [ ] **Step 6: Full suite, typecheck, build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all tests PASS (including the new Appearance test and every prior options test); no type errors; build succeeds.

- [ ] **Step 7: Manual check**

Open the options page: it uses the aubergine/token styling and shows the Appearance selector. Switch it to Dark → options and any open panel re-theme live; reload → the choice persists. Switch back to System → follows the OS.

- [ ] **Step 8: Commit**

```bash
git add src/options/options.css src/options/OptionsView.tsx src/options/OptionsView.test.tsx package.json public/manifest.json
git commit -m "style: themed options page with Appearance control; v0.7.0"
```

---

## Self-Review

**1. Spec coverage:**
- Token sheet (light on `:root`, dark under `[data-theme="dark"]`) → Task 2. ✓
- `theme` setting + default `system` → Task 1. ✓
- Pure resolver + applier reacting to setting + OS → Tasks 1–2. ✓
- Panel restyle (aubergine header, subtitle, avatars, grouping, mine-pills, composer green send) → Tasks 5–7. ✓
- Options restyle + Appearance control → Task 8. ✓
- Unit tests for resolver, avatar, grouping; settings round-trip; component tests updated → Tasks 1,3,4,5,8. ✓
- Non-goals (no toolbar, no behavior/badge change, system font) honored — Global Constraints + no touch to send/badge/sanitize paths. ✓
- Version 0.7.0 → Task 8. ✓

**2. Placeholder scan:** No TBD/TODO; every code/CSS step contains full content. ✓

**3. Type consistency:** `ThemePref` defined in Task 1, imported by `settings.ts`, `theme.ts` applier, and `OptionsView.tsx`. `resolveEffectiveTheme`/`applyTheme`/`startThemeSync` signatures match between Task 2's implementation, tests, and the `main.tsx` call sites. `grouped?: boolean` prop added in Task 5 and passed by `ThreadView`. `headerSubtitle(entityUri, count)` matches its call in `App.tsx`. `startsNewGroup(prev, cur)` and `avatarInitial`/`avatarColor` signatures match their consumers. ✓

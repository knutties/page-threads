# M2d Resolver Versioning Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make resolution produce a structured `{resolverId, resolverVersion}` and record it in the header message (replacing the hardcoded `web@1`), so resolver identity is a durable, forward-compatible contract.

**Architecture:** A new `resolver.ts` owns the web resolver's identity (`RESOLVER_ID`, `RESOLVER_VERSION`) and a `resolveWebEntity` wrapper around `canonicalize`. `PageEntity` gains `resolverId`/`resolverVersion`, produced by the content script and passed through the SW. The header message helper is extracted to a testable module and sources the resolver tag from the entity.

**Tech Stack:** TypeScript (strict), Preact, Vitest, Chrome MV3 (content script + service worker + side panel).

## Global Constraints

- Version bumped to **0.8.2** (`package.json` + `public/manifest.json`) in the final task, verbatim.
- No behavior change — today's header output stays `web@1`; `RESOLVER_VERSION = 1`.
- `RESOLVER_VERSION` is bumped DELIBERATELY (a §4.4 algorithm change is a versioned act, §4.5) — never automatically.
- Drift detection and the read-only "earlier discussion" merge view are OUT of scope (deferred backlog); do not build them.
- TypeScript strict; existing tests updated only where a `PageEntity` fixture needs the two new fields (mechanical), never weakened.

---

### Task 1: Resolver descriptor module (`resolver.ts`)

**Files:**
- Create: `src/shared/resolver.ts`
- Create: `src/shared/resolver.test.ts`

**Interfaces:**
- Consumes: `canonicalize`, `CanonicalRule` (`src/shared/canonicalize.ts`).
- Produces: `RESOLVER_ID = 'web'`, `RESOLVER_VERSION = 1`, `interface ResolvedEntity { entityUri: string; resolverId: string; resolverVersion: number }`, `resolveWebEntity(href: string, canonicalHref: string | null, canonicalRules?: Record<string, CanonicalRule>): ResolvedEntity`.

- [ ] **Step 1: Write the failing test** — `src/shared/resolver.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { RESOLVER_ID, RESOLVER_VERSION, resolveWebEntity } from './resolver'

describe('resolveWebEntity', () => {
  test('prefixes the canonicalized URL with web: and tags the descriptor', () => {
    expect(resolveWebEntity('https://example.com/a', null)).toEqual({
      entityUri: 'web:https://example.com/a',
      resolverId: 'web',
      resolverVersion: 1,
    })
  })

  test('applies a canonical rule (keepParams) via canonicalize', () => {
    const r = resolveWebEntity('https://news.ycombinator.com/item?id=42&utm_source=x', null, {
      'news.ycombinator.com': { keepParams: ['id'] },
    })
    expect(r.entityUri).toBe('web:https://news.ycombinator.com/item?id=42')
  })

  test('exposes the resolver id and version constants', () => {
    expect(RESOLVER_ID).toBe('web')
    expect(RESOLVER_VERSION).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/shared/resolver.test.ts`
Expected: FAIL — cannot resolve `./resolver`.

- [ ] **Step 3: Implement** — `src/shared/resolver.ts`

```ts
import { canonicalize, type CanonicalRule } from './canonicalize'

export const RESOLVER_ID = 'web'
/**
 * The §4.4 web-canonicalization algorithm version. Bump this DELIBERATELY when the
 * algorithm changes in a way that re-keys existing threads (a versioned act per §4.5)
 * — never automatically.
 */
export const RESOLVER_VERSION = 1

export interface ResolvedEntity {
  entityUri: string
  resolverId: string
  resolverVersion: number
}

/** The generic web resolver (§4.4): canonicalize, prefix with `web:`, tag with the descriptor. */
export function resolveWebEntity(
  href: string,
  canonicalHref: string | null,
  canonicalRules?: Record<string, CanonicalRule>
): ResolvedEntity {
  return {
    entityUri: 'web:' + canonicalize(href, canonicalHref, canonicalRules),
    resolverId: RESOLVER_ID,
    resolverVersion: RESOLVER_VERSION,
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/shared/resolver.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/resolver.ts src/shared/resolver.test.ts
git commit -m "feat: web resolver descriptor (RESOLVER_ID/VERSION + resolveWebEntity)"
```

---

### Task 2: Thread the descriptor through `PageEntity` (content → SW)

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/content/index.ts`
- Modify: `src/background/index.ts`
- Modify: `src/panel/panelTarget.test.ts` (fixture)

**Interfaces:**
- Consumes: `RESOLVER_ID`, `RESOLVER_VERSION`, `resolveWebEntity` (Task 1).
- Produces: `PageEntity` now `{ entityUri: string; title: string; resolverId: string; resolverVersion: number }`.

- [ ] **Step 1: Add the fields to `PageEntity`** — `src/shared/messages.ts`

Change the interface (currently `{ entityUri: string; title: string }`) to:

```ts
export interface PageEntity {
  entityUri: string
  title: string
  resolverId: string
  resolverVersion: number
}
```

- [ ] **Step 2: Produce the descriptor in the content script** — `src/content/index.ts`

Replace the `canonicalize` import with the resolver import (top of file):

```ts
import { RESOLVER_ID, RESOLVER_VERSION, resolveWebEntity } from '../shared/resolver'
```

(remove `import { canonicalize } from '../shared/canonicalize'` — it's now used only inside `resolveWebEntity`.)

Change `resolveUri()` to delegate to the resolver (keeps the `web:` prefix in one place):

```ts
function resolveUri(): string {
  const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  return resolveWebEntity(location.href, link?.getAttribute('href') ?? null, ruleset.canonical).entityUri
}
```

Attach the descriptor constants in `report(...)`:

```ts
function report(entityUri: string): void {
  const msg: ContentToSw = {
    type: 'pageEntity',
    entityUri,
    title: document.title,
    resolverId: RESOLVER_ID,
    resolverVersion: RESOLVER_VERSION,
  }
  void chrome.runtime.sendMessage(msg).catch(() => {
    // Service worker may not be listening yet (e.g. right after install); harmless.
  })
}
```

And in the `queryEntity` `sendResponse` (bottom of the file), include them:

```ts
      sendResponse({
        entityUri: resolveUri(),
        title: document.title,
        resolverId: RESOLVER_ID,
        resolverVersion: RESOLVER_VERSION,
      })
```

(Every reported entity is a `web:` one — blocked domains send `pageBlocked` and never construct a `PageEntity` — so the constants are always correct.)

- [ ] **Step 3: Carry the fields through the SW** — `src/background/index.ts`

The `pageEntity` message handler currently reconstructs the entity with only two fields. Change:

```ts
    tabEntities.set(sender.tab.id, { entityUri: msg.entityUri, title: msg.title })
```

to include the descriptor (`msg` is the `pageEntity` variant of `ContentToSw`, which spreads `PageEntity`, so the fields are present):

```ts
    tabEntities.set(sender.tab.id, {
      entityUri: msg.entityUri,
      title: msg.title,
      resolverId: msg.resolverId,
      resolverVersion: msg.resolverVersion,
    })
```

(`entityForTab`'s `queryEntity` reply returns the whole `PageEntity` object and the `activeEntity` broadcast passes the entity through unchanged — no other SW change needed.)

- [ ] **Step 4: Update the `PageEntity` test fixture** — `src/panel/panelTarget.test.ts`

The fixture helper (currently `const entity = (uri: string) => ({ entityUri: uri, title: 'T' })`) becomes:

```ts
const entity = (uri: string) => ({ entityUri: uri, title: 'T', resolverId: 'web', resolverVersion: 1 })
```

- [ ] **Step 5: Typecheck, build, full suite**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: no type errors; build succeeds; all tests PASS. If `tsc` flags any other test that constructs a `PageEntity` without the new fields, add `resolverId: 'web', resolverVersion: 1` to that fixture too (mechanical; do not change assertions). (`panelTarget.test.ts` is the only known one.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/messages.ts src/content/index.ts src/background/index.ts src/panel/panelTarget.test.ts
git commit -m "feat: carry resolverId/resolverVersion on PageEntity from content script through the SW"
```

---

### Task 3: Header message records the descriptor + version bump

**Files:**
- Create: `src/panel/headerMessage.ts`
- Create: `src/panel/headerMessage.test.ts`
- Modify: `src/panel/App.tsx` (remove the local `headerMessage`, import the module)
- Modify: `package.json`, `public/manifest.json` (version → 0.8.2)

**Interfaces:**
- Consumes: `PageEntity` with `resolverId`/`resolverVersion` (Task 2).
- Produces: `headerMessage(entity: PageEntity, email: string): string`.

- [ ] **Step 1: Write the failing test** — `src/panel/headerMessage.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import type { PageEntity } from '../shared/messages'
import { headerMessage } from './headerMessage'

const entity = (over: Partial<PageEntity> = {}): PageEntity => ({
  entityUri: 'web:https://x.com/a',
  title: 'X Article',
  resolverId: 'web',
  resolverVersion: 1,
  ...over,
})

describe('headerMessage', () => {
  test('renders the §4.6 format, records resolver id@version, strips web: in the link', () => {
    expect(headerMessage(entity(), 'me@x.com')).toBe(
      [
        '🔗 Discussion for: X Article',
        'Entity: `web:https://x.com/a` (resolver web@1)',
        'Link: https://x.com/a',
        'Started by me@x.com',
      ].join('\n')
    )
  })

  test('sources the version from the entity, not a hardcoded literal', () => {
    expect(headerMessage(entity({ resolverVersion: 2 }), 'me@x.com')).toContain('(resolver web@2)')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/panel/headerMessage.test.ts`
Expected: FAIL — cannot resolve `./headerMessage`.

- [ ] **Step 3: Create the module** — `src/panel/headerMessage.ts`

```ts
import type { PageEntity } from '../shared/messages'

/** The first message posted to a new topic — the §4.6 header. Records the resolver
 *  identity that produced the entity, so a future version bump is self-describing. */
export function headerMessage(entity: PageEntity, email: string): string {
  const representativeUrl = entity.entityUri.replace(/^web:/, '')
  return [
    `🔗 Discussion for: ${entity.title}`,
    `Entity: \`${entity.entityUri}\` (resolver ${entity.resolverId}@${entity.resolverVersion})`,
    `Link: ${representativeUrl}`,
    `Started by ${email}`,
  ].join('\n')
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/panel/headerMessage.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Use the module in `App.tsx`**

Delete the local `function headerMessage(entity, email) { … }` from `src/panel/App.tsx` and add the import alongside the other `./` imports:

```ts
import { headerMessage } from './headerMessage'
```

(The existing call site `headerMessage(t.entity, creds.email)` is unchanged.)

- [ ] **Step 6: Bump the version to 0.8.2**

In `package.json` set `"version": "0.8.2"`. In `public/manifest.json` set `"version": "0.8.2"`.

- [ ] **Step 7: Typecheck, build, full suite**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: no type errors; build succeeds; all tests PASS (including the two new `headerMessage` tests; `App.tsx`'s call site compiles against the imported function).

- [ ] **Step 8: Commit**

```bash
git add src/panel/headerMessage.ts src/panel/headerMessage.test.ts src/panel/App.tsx package.json public/manifest.json
git commit -m "feat: header message records the resolver id@version from the entity; v0.8.2"
```

---

## Manual Acceptance (after all tasks)

1. On a fresh page, post the first message → the header message's `Entity:` line reads `(resolver web@1)`, unchanged from before (sourced from the entity now, not a literal).
2. No user-visible behavior change: resolution, threads, badge, offline all behave as before.

## Self-Review

**1. Spec coverage:**
- Resolver descriptor module (`RESOLVER_ID`/`RESOLVER_VERSION` + `resolveWebEntity`) → Task 1. ✓
- `PageEntity` carries `resolverId`/`resolverVersion`; content produces them; SW passes them through → Task 2. ✓
- Header records `${resolverId}@${resolverVersion}` (extracted, testable) → Task 3. ✓
- Test-fixture ripple (mechanical field addition) → Task 2 Step 4/5. ✓
- No drift detection / merge view (deferred) — nothing in the plan builds them. ✓
- Version 0.8.2 → Task 3 Step 6. ✓

**2. Placeholder scan:** No TBD/TODO; every step has full code; the exact `PageEntity` field additions, SW handler change, and header format are shown. ✓

**3. Type consistency:** `ResolvedEntity`/`resolveWebEntity` defined in Task 1, consumed in Task 2. `PageEntity` shape (`entityUri`, `title`, `resolverId`, `resolverVersion`) is consistent across messages.ts, content, SW, the fixture, and `headerMessage`. `RESOLVER_ID`/`RESOLVER_VERSION` names match between resolver.ts and the content script. `headerMessage(entity, email)` signature matches its `App.tsx` call site. ✓

# PageThreads M1d-2 — Resolver Rules + Domain Block-List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-domain canonicalization rules and a domain block-list, edited from the options page and stored in `chrome.storage.sync`, plus three M1d-1 review carries.

**Architecture:** A pure `applyDomainRules` composes into `canonicalize` via a new optional ruleset arg (additive, all existing callers unaffected). A `ruleset` store on `storage.sync` holds `{ canonical, blocked }`. The content script loads the ruleset, bails on blocked domains, and passes rules into canonicalization. The options page grows a structured rules editor (pure `rulesReducer`) with JSON import/export and a blocked-domains list. Backlog: settings-load-ordered strict-privacy gate, `checkedRef` removal, options save error handling.

**Tech Stack:** Existing — TypeScript strict, Vite, Preact, Vitest (+ @testing-library/preact + jsdom), tldts, DOMPurify. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-14-m1d2-resolver-rules-blocklist-design.md`.

## Global Constraints

- Ruleset lives in `chrome.storage.sync` (roams across a user's Chrome profiles); everything else stays `local`.
- `canonicalize`'s new 3rd param is OPTIONAL; omitting it must behave exactly as today (all existing canonicalize tests pass UNCHANGED).
- `keepParams` narrows the query to only the listed params, applied AFTER the existing tracking-strip + lexicographic sort. `pathRewrite` replaces the pathname. No rule for a domain → URL unchanged.
- A blocked domain → content script sends NO `pageEntity` (and the queryEntity responder returns nothing usable). Registrable-domain match via `tldts.getDomain`.
- `src/shared/*` keeps chrome APIs only as default parameter values.
- Client-side rules are per-user (thread-split limitation is documented, not engineered away).
- Version `0.5.0` in `package.json` + `public/manifest.json` (Task 8). Existing 191 tests keep passing.
- Branch `m1d2-resolver-rules-blocklist` off main. Commit trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LpgtuXYp32egiB82M3qkAb`

---

### Task 1: Ruleset store + isBlocked (`shared/ruleset.ts`)

**Files:**
- Create: `src/shared/ruleset.ts`
- Test: `src/shared/ruleset.test.ts`

**Interfaces:**
- Consumes: `createStore`, `Store`, `StorageAreaLike`, `StorageChangedLike` (existing `src/shared/storage.ts`).
- Produces (consumed by Tasks 3, 5, 6):

```ts
interface CanonicalRule { keepParams?: string[]; pathRewrite?: string }
interface Ruleset { canonical: Record<string, CanonicalRule>; blocked: string[] }
const DEFAULT_RULESET: Ruleset
function createRulesetStore(area?, changed?, areaName?): Store<Ruleset>   // defaults chrome.storage.sync / 'sync'
function isBlocked(domain: string, blocked: string[]): boolean
```

- [ ] **Step 1: Write the failing tests**

`src/shared/ruleset.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { createRulesetStore, DEFAULT_RULESET, isBlocked, type Ruleset } from './ruleset'
import type { ChangeListener } from './storage'

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  const listeners = new Set<ChangeListener>()
  const area = {
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items)
      for (const l of listeners) {
        l(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])), 'sync')
      }
    },
  }
  const changed = {
    addListener: (l: ChangeListener) => listeners.add(l),
    removeListener: (l: ChangeListener) => listeners.delete(l),
  }
  return { area, changed, data }
}

describe('ruleset store', () => {
  test('load returns defaults (empty canonical, seeded blocked) when empty', async () => {
    const { area, changed } = fakeStorage()
    const rs = await createRulesetStore(area, changed, 'sync').load()
    expect(rs.canonical).toEqual({})
    expect(Array.isArray(rs.blocked)).toBe(true)
    expect(rs).toEqual(DEFAULT_RULESET)
  })

  test('save merges a canonical rule; load reflects it', async () => {
    const { area, changed } = fakeStorage()
    const store = createRulesetStore(area, changed, 'sync')
    const next: Ruleset = { canonical: { 'news.ycombinator.com': { keepParams: ['id'] } }, blocked: [] }
    await store.save(next)
    expect((await store.load()).canonical['news.ycombinator.com']).toEqual({ keepParams: ['id'] })
  })

  test('watch fires on the sync area with merged value', async () => {
    const { area, changed } = fakeStorage()
    const store = createRulesetStore(area, changed, 'sync')
    const seen: Ruleset[] = []
    store.watch((r) => seen.push(r))
    await area.set({ ruleset: { canonical: { 'x.com': { pathRewrite: '/w' } }, blocked: [] } })
    expect(seen).toHaveLength(1)
    expect(seen[0].canonical['x.com']).toEqual({ pathRewrite: '/w' })
  })
})

describe('isBlocked', () => {
  test('exact registrable-domain match', () => {
    expect(isBlocked('example.com', ['example.com'])).toBe(true)
  })

  test('subdomain of a blocked registrable domain is blocked', () => {
    expect(isBlocked('mail.example.com', ['example.com'])).toBe(true)
  })

  test('unrelated domain is not blocked', () => {
    expect(isBlocked('example.org', ['example.com'])).toBe(false)
  })

  test('empty block-list blocks nothing', () => {
    expect(isBlocked('example.com', [])).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/shared/ruleset.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/shared/ruleset.ts`:

```ts
import { getDomain } from 'tldts'
import { createStore, type StorageAreaLike, type StorageChangedLike, type Store } from './storage'

export interface CanonicalRule {
  keepParams?: string[]
  pathRewrite?: string
}

export interface Ruleset {
  canonical: Record<string, CanonicalRule>
  blocked: string[]
}

/** Blocked defaults are illustrative examples, not an exhaustive privacy guarantee (spec §7). */
export const DEFAULT_RULESET: Ruleset = {
  canonical: {},
  blocked: ['examplebank.com', 'examplehealth.com'],
}

export function createRulesetStore(
  area: StorageAreaLike = chrome.storage.sync,
  changed: StorageChangedLike = chrome.storage.onChanged,
  areaName = 'sync'
): Store<Ruleset> {
  return createStore('ruleset', DEFAULT_RULESET, area, changed, areaName)
}

/** True when `domain`'s registrable domain is in the block-list (matches the domain or any subdomain). */
export function isBlocked(domain: string, blocked: string[]): boolean {
  const registrable = getDomain(domain) ?? domain
  return blocked.some((b) => {
    const bReg = getDomain(b) ?? b
    return bReg === registrable
  })
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/shared/ruleset.test.ts && npx tsc --noEmit`
Expected: PASS (7 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ruleset.ts src/shared/ruleset.test.ts
git commit -m "feat: ruleset store on storage.sync + isBlocked domain check"
```

---

### Task 2: Canonicalization step 3 (`applyDomainRules` + canonicalize arg)

**Files:**
- Modify: `src/shared/canonicalize.ts`
- Modify: `src/shared/canonicalize.test.ts` (append; existing tests unchanged)

**Interfaces:**
- Consumes: `CanonicalRule` (Task 1).
- Produces (consumed by Task 3): `canonicalize(href, canonicalHref, canonical?)` where `canonical?: Record<string, CanonicalRule>`; internal pure `applyDomainRules(url, canonical)`.

- [ ] **Step 1: Append the failing tests**

Append to `src/shared/canonicalize.test.ts`:

```ts
describe('per-domain rules (spec §4.4 step 3)', () => {
  const hnRule = { 'news.ycombinator.com': { keepParams: ['id'] } }
  const ytRule = { 'youtube.com': { keepParams: ['v'], pathRewrite: '/watch' } }

  test('keepParams narrows the query to only the listed params', () => {
    expect(
      canonicalize('https://news.ycombinator.com/item?id=42&utm_source=x&foo=bar', null, hnRule)
    ).toBe('https://news.ycombinator.com/item?id=42')
  })

  test('a page with none of the kept params drops all query', () => {
    expect(canonicalize('https://news.ycombinator.com/news?p=2', null, hnRule)).toBe(
      'https://news.ycombinator.com/news'
    )
  })

  test('pathRewrite replaces the path; keepParams keeps v', () => {
    expect(
      canonicalize('https://www.youtube.com/watch?v=abc123&list=xyz&t=10', null, ytRule)
    ).toBe('https://www.youtube.com/watch?v=abc123')
  })

  test('a domain with no rule is unchanged by the rules pass', () => {
    expect(canonicalize('https://example.com/a?z=1&a=2', null, hnRule)).toBe(
      'https://example.com/a?a=2&z=1'
    )
  })

  test('rules apply on subdomains of the registrable domain', () => {
    expect(canonicalize('https://m.youtube.com/watch?v=q&extra=1', null, ytRule)).toBe(
      'https://m.youtube.com/watch?v=q'
    )
  })

  test('omitting the ruleset behaves exactly as before', () => {
    expect(canonicalize('https://news.ycombinator.com/item?id=42&foo=bar', null)).toBe(
      'https://news.ycombinator.com/item?foo=bar&id=42'
    )
  })

  test('an accepted canonical link short-circuits before domain rules', () => {
    expect(
      canonicalize(
        'https://news.ycombinator.com/item?id=42&foo=bar',
        'https://news.ycombinator.com/canonical',
        hnRule
      )
    ).toBe('https://news.ycombinator.com/canonical')
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/shared/canonicalize.test.ts`
Expected: the new tests FAIL (3rd arg unsupported / not applied).

- [ ] **Step 3: Implement**

In `src/shared/canonicalize.ts`, add the import and helper, and thread the param through. Add near the top:

```ts
import type { CanonicalRule } from './ruleset'
```

Add the pure helper above `canonicalize`:

```ts
/** Spec §4.4 step 3: per-domain keepParams narrowing + pathRewrite. Pure; no-op when no rule matches. */
function applyDomainRules(url: string, canonical: Record<string, CanonicalRule>): string {
  const u = new URL(url)
  const registrable = getDomain(u.hostname)
  const rule = registrable ? canonical[registrable] : undefined
  if (!rule) return url
  if (rule.pathRewrite !== undefined) u.pathname = rule.pathRewrite
  if (rule.keepParams !== undefined) {
    const keep = new Set(rule.keepParams)
    const sp = new URLSearchParams()
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (keep.has(k)) sp.append(k, v)
    }
    u.search = sp.toString()
  }
  return u.origin + u.pathname + (u.search ? u.search : '')
}
```

Change the `canonicalize` signature and its final return. The signature line becomes:

```ts
export function canonicalize(
  href: string,
  canonicalHref: string | null,
  canonical?: Record<string, CanonicalRule>
): string {
```

Replace the final `return` (the step-2 return `return u.origin + u.pathname + (q ? \`?${q}\` : '')`) with:

```ts
  const normalized = u.origin + u.pathname + (q ? `?${q}` : '')
  return canonical ? applyDomainRules(normalized, canonical) : normalized
```

(The step-1 canonical-link `return accepted` path is untouched, so an accepted canonical link short-circuits before rules — matching the test.)

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/shared/canonicalize.test.ts && npx tsc --noEmit`
Expected: PASS (existing + 7 new); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/canonicalize.ts src/shared/canonicalize.test.ts
git commit -m "feat: canonicalization step 3 — per-domain keepParams and pathRewrite"
```

---

### Task 3: Content script loads ruleset, bails on blocked domains

**Files:**
- Modify: `src/content/index.ts`

**Interfaces:**
- Consumes: `createRulesetStore`, `isBlocked`, `Ruleset` (Task 1); `canonicalize` with rules (Task 2).
- Produces: content-script behavior (no unit test — chrome glue; verified in Task 8 manual checklist).

- [ ] **Step 1: Rewrite the content script**

`src/content/index.ts` (replace entire file):

```ts
import { canonicalize } from '../shared/canonicalize'
import type { ContentToSw, SwToContent } from '../shared/messages'
import { createRulesetStore, isBlocked, type Ruleset } from '../shared/ruleset'
import { createNavWatcher } from './navWatcher'

const rulesetStore = createRulesetStore()
let ruleset: Ruleset = { canonical: {}, blocked: [] }

function pageDomain(): string {
  return location.hostname
}

function resolveUri(): string {
  const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  return 'web:' + canonicalize(location.href, link?.getAttribute('href') ?? null, ruleset.canonical)
}

function report(entityUri: string): void {
  const msg: ContentToSw = { type: 'pageEntity', entityUri, title: document.title }
  void chrome.runtime.sendMessage(msg).catch(() => {
    // Service worker may not be listening yet (e.g. right after install); harmless.
  })
}

function resolveAndReport(): void {
  // Blocked domains: send nothing, so the SW never learns the page (spec §7).
  if (isBlocked(pageDomain(), ruleset.blocked)) return
  report(resolveUri())
}

const watcher = createNavWatcher({
  resolve: () => (isBlocked(pageDomain(), ruleset.blocked) ? 'blocked:' + pageDomain() : resolveUri()),
  onChange: (uri) => {
    if (!uri.startsWith('blocked:')) report(uri)
  },
})

// Ruleset governs canonicalization AND blocking; load it before the first report.
void rulesetStore.load().then((rs) => {
  ruleset = rs
  watcher.seed(isBlocked(pageDomain(), rs.blocked) ? 'blocked:' + pageDomain() : resolveUri())
  resolveAndReport()
})

// A change to rules or the block-list re-resolves on the next navigation; also
// re-evaluate the current page once so a freshly-blocked domain stops reporting.
rulesetStore.watch((rs) => {
  ruleset = rs
  resolveAndReport()
})

window.addEventListener('popstate', () => watcher.trigger())

const navigation = (window as { navigation?: EventTarget }).navigation
if (navigation) {
  navigation.addEventListener('navigate', () => watcher.trigger())
} else {
  const title = document.querySelector('title')
  if (title) {
    new MutationObserver(() => watcher.trigger()).observe(title, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  }
  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      watcher.trigger()
    }
  }, 500)
}

// The SW's tab-entity map dies with every MV3 service-worker restart; let it
// re-query this tab. A blocked domain returns nothing usable.
chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
  if (msg.type === 'queryEntity') {
    if (isBlocked(pageDomain(), ruleset.blocked)) {
      sendResponse(null)
    } else {
      sendResponse({ entityUri: resolveUri(), title: document.title })
    }
  }
})
```

Note: `entityForTab` in the SW already treats a falsy reply as "no entity" (`if (entity)` guard), so `sendResponse(null)` on a blocked domain is handled without an SW change. Verify this during Step 2 by reading `src/background/index.ts`'s `entityForTab`; if it does not guard falsy, that is a bug to flag, not silently fix.

- [ ] **Step 2: Verify build + existing suite + the SW falsy-reply guard**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all green (no new unit tests; existing suite unaffected). Confirm `entityForTab` guards a falsy reply (read the function); note the confirmation in the commit body if you like.

- [ ] **Step 3: Commit**

```bash
git add src/content/index.ts
git commit -m "feat: content script applies domain rules and bails on blocked domains"
```

---

### Task 4: Rules reducer + validation (`options/rulesReducer.ts`)

**Files:**
- Create: `src/options/rulesReducer.ts`
- Test: `src/options/rulesReducer.test.ts`

**Interfaces:**
- Consumes: `Ruleset`, `CanonicalRule` (Task 1).
- Produces (consumed by Task 5):

```ts
type RulesAction =
  | { type: 'addDomain'; domain: string }
  | { type: 'removeDomain'; domain: string }
  | { type: 'setKeepParams'; domain: string; keepParams: string[] }
  | { type: 'setPathRewrite'; domain: string; pathRewrite: string }
  | { type: 'addBlocked'; domain: string }
  | { type: 'removeBlocked'; domain: string }
function rulesReducer(rs: Ruleset, action: RulesAction): Ruleset
function validateRuleset(raw: unknown): { ok: true; value: Ruleset } | { ok: false; error: string }
function parseKeepParams(input: string): string[]   // "a, b ,c" → ['a','b','c']; ''/whitespace → []
```

- [ ] **Step 1: Write the failing tests**

`src/options/rulesReducer.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { parseKeepParams, rulesReducer, validateRuleset } from './rulesReducer'
import type { Ruleset } from '../shared/ruleset'

const empty: Ruleset = { canonical: {}, blocked: [] }

describe('rulesReducer', () => {
  test('addDomain creates an empty rule; removeDomain deletes it', () => {
    const a = rulesReducer(empty, { type: 'addDomain', domain: 'x.com' })
    expect(a.canonical).toEqual({ 'x.com': {} })
    const b = rulesReducer(a, { type: 'removeDomain', domain: 'x.com' })
    expect(b.canonical).toEqual({})
  })

  test('addDomain on an existing domain is a no-op (keeps its rule)', () => {
    const a: Ruleset = { canonical: { 'x.com': { keepParams: ['id'] } }, blocked: [] }
    expect(rulesReducer(a, { type: 'addDomain', domain: 'x.com' }).canonical['x.com']).toEqual({
      keepParams: ['id'],
    })
  })

  test('setKeepParams / setPathRewrite update the domain rule', () => {
    let rs = rulesReducer(empty, { type: 'addDomain', domain: 'x.com' })
    rs = rulesReducer(rs, { type: 'setKeepParams', domain: 'x.com', keepParams: ['id', 'v'] })
    rs = rulesReducer(rs, { type: 'setPathRewrite', domain: 'x.com', pathRewrite: '/w' })
    expect(rs.canonical['x.com']).toEqual({ keepParams: ['id', 'v'], pathRewrite: '/w' })
  })

  test('setKeepParams with an empty array removes the keepParams field', () => {
    let rs: Ruleset = { canonical: { 'x.com': { keepParams: ['id'] } }, blocked: [] }
    rs = rulesReducer(rs, { type: 'setKeepParams', domain: 'x.com', keepParams: [] })
    expect(rs.canonical['x.com']).toEqual({})
  })

  test('setPathRewrite with empty string removes the pathRewrite field', () => {
    let rs: Ruleset = { canonical: { 'x.com': { pathRewrite: '/w' } }, blocked: [] }
    rs = rulesReducer(rs, { type: 'setPathRewrite', domain: 'x.com', pathRewrite: '' })
    expect(rs.canonical['x.com']).toEqual({})
  })

  test('addBlocked / removeBlocked; addBlocked dedupes', () => {
    let rs = rulesReducer(empty, { type: 'addBlocked', domain: 'a.com' })
    rs = rulesReducer(rs, { type: 'addBlocked', domain: 'a.com' })
    expect(rs.blocked).toEqual(['a.com'])
    rs = rulesReducer(rs, { type: 'removeBlocked', domain: 'a.com' })
    expect(rs.blocked).toEqual([])
  })
})

describe('parseKeepParams', () => {
  test('splits, trims, drops empties', () => {
    expect(parseKeepParams(' id , v ,, ')).toEqual(['id', 'v'])
    expect(parseKeepParams('   ')).toEqual([])
  })
})

describe('validateRuleset', () => {
  test('accepts a well-formed ruleset', () => {
    const r = validateRuleset({ canonical: { 'x.com': { keepParams: ['id'], pathRewrite: '/w' } }, blocked: ['a.com'] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.canonical['x.com'].keepParams).toEqual(['id'])
  })

  test('accepts a bare {} by filling defaults', () => {
    const r = validateRuleset({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ canonical: {}, blocked: [] })
  })

  test.each([
    ['not an object', 'canonical must be an object'],
    [{ canonical: [], blocked: [] }, 'canonical must be an object'],
    [{ canonical: {}, blocked: 'a.com' }, 'blocked must be an array of strings'],
    [{ canonical: { 'x.com': { keepParams: 'id' } }, blocked: [] }, 'keepParams must be an array of strings'],
    [{ canonical: { 'x.com': { pathRewrite: 3 } }, blocked: [] }, 'pathRewrite must be a string'],
  ])('rejects %s', (input, msg) => {
    const r = validateRuleset(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(msg)
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/options/rulesReducer.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/options/rulesReducer.ts`:

```ts
import type { CanonicalRule, Ruleset } from '../shared/ruleset'

export type RulesAction =
  | { type: 'addDomain'; domain: string }
  | { type: 'removeDomain'; domain: string }
  | { type: 'setKeepParams'; domain: string; keepParams: string[] }
  | { type: 'setPathRewrite'; domain: string; pathRewrite: string }
  | { type: 'addBlocked'; domain: string }
  | { type: 'removeBlocked'; domain: string }

export function parseKeepParams(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function withCanonical(rs: Ruleset, domain: string, rule: CanonicalRule): Ruleset {
  return { ...rs, canonical: { ...rs.canonical, [domain]: rule } }
}

export function rulesReducer(rs: Ruleset, action: RulesAction): Ruleset {
  switch (action.type) {
    case 'addDomain':
      if (rs.canonical[action.domain]) return rs
      return withCanonical(rs, action.domain, {})
    case 'removeDomain': {
      const next = { ...rs.canonical }
      delete next[action.domain]
      return { ...rs, canonical: next }
    }
    case 'setKeepParams': {
      const rule = { ...(rs.canonical[action.domain] ?? {}) }
      if (action.keepParams.length) rule.keepParams = action.keepParams
      else delete rule.keepParams
      return withCanonical(rs, action.domain, rule)
    }
    case 'setPathRewrite': {
      const rule = { ...(rs.canonical[action.domain] ?? {}) }
      if (action.pathRewrite) rule.pathRewrite = action.pathRewrite
      else delete rule.pathRewrite
      return withCanonical(rs, action.domain, rule)
    }
    case 'addBlocked':
      if (rs.blocked.includes(action.domain)) return rs
      return { ...rs, blocked: [...rs.blocked, action.domain] }
    case 'removeBlocked':
      return { ...rs, blocked: rs.blocked.filter((d) => d !== action.domain) }
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

export function validateRuleset(
  raw: unknown
): { ok: true; value: Ruleset } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Ruleset must be a JSON object.' }
  }
  const obj = raw as Record<string, unknown>
  const canonicalRaw = obj.canonical ?? {}
  if (typeof canonicalRaw !== 'object' || canonicalRaw === null || Array.isArray(canonicalRaw)) {
    return { ok: false, error: 'canonical must be an object of domain → rule.' }
  }
  const canonical: Record<string, CanonicalRule> = {}
  for (const [domain, ruleRaw] of Object.entries(canonicalRaw as Record<string, unknown>)) {
    if (typeof ruleRaw !== 'object' || ruleRaw === null || Array.isArray(ruleRaw)) {
      return { ok: false, error: `rule for ${domain} must be an object.` }
    }
    const rule = ruleRaw as Record<string, unknown>
    const out: CanonicalRule = {}
    if (rule.keepParams !== undefined) {
      if (!isStringArray(rule.keepParams)) {
        return { ok: false, error: `keepParams must be an array of strings (${domain}).` }
      }
      out.keepParams = rule.keepParams
    }
    if (rule.pathRewrite !== undefined) {
      if (typeof rule.pathRewrite !== 'string') {
        return { ok: false, error: `pathRewrite must be a string (${domain}).` }
      }
      out.pathRewrite = rule.pathRewrite
    }
    canonical[domain] = out
  }
  const blockedRaw = obj.blocked ?? []
  if (!isStringArray(blockedRaw)) {
    return { ok: false, error: 'blocked must be an array of strings.' }
  }
  return { ok: true, value: { canonical, blocked: blockedRaw } }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/options/rulesReducer.test.ts && npx tsc --noEmit`
Expected: PASS (13 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/options/rulesReducer.ts src/options/rulesReducer.test.ts
git commit -m "feat: rules reducer, keepParams parsing, and ruleset validation"
```

---

### Task 5: Rules editor UI (`options/RulesEditor.tsx`) + options integration

**Files:**
- Create: `src/options/RulesEditor.tsx`
- Modify: `src/options/OptionsView.tsx`, `src/options/options.css` (append)
- Test: `src/options/RulesEditor.test.tsx`

**Interfaces:**
- Consumes: `rulesReducer`/`validateRuleset`/`parseKeepParams` (Task 4), `Ruleset`/`createRulesetStore` (Task 1).
- Produces: the rules + blocked editor mounted in the options page.

- [ ] **Step 1: Write the failing tests**

`src/options/RulesEditor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, test } from 'vitest'
import type { Ruleset } from '../shared/ruleset'
import type { Store } from '../shared/storage'
import { RulesEditor } from './RulesEditor'

function fakeStore(initial: Ruleset): Store<Ruleset> & { current: Ruleset } {
  const s = {
    current: { ...initial },
    load: async () => s.current,
    save: async (patch: Partial<Ruleset>) => {
      s.current = { ...s.current, ...patch }
    },
    watch: () => () => {},
  }
  return s as Store<Ruleset> & { current: Ruleset }
}

describe('RulesEditor', () => {
  test('renders existing domain rows', async () => {
    const store = fakeStore({ canonical: { 'news.ycombinator.com': { keepParams: ['id'] } }, blocked: [] })
    render(<RulesEditor store={store} />)
    expect(await screen.findByDisplayValue('news.ycombinator.com')).toBeTruthy()
    expect(screen.getByDisplayValue('id')).toBeTruthy()
  })

  test('adding a domain writes through the store', async () => {
    const store = fakeStore({ canonical: {}, blocked: [] })
    render(<RulesEditor store={store} />)
    await screen.findByText('Canonicalization rules')
    fireEvent.input(screen.getByPlaceholderText('add domain, e.g. news.ycombinator.com'), {
      target: { value: 'x.com' },
    })
    fireEvent.click(screen.getByText('Add domain'))
    await waitFor(() => expect(store.current.canonical['x.com']).toEqual({}))
  })

  test('editing keepParams writes a parsed array', async () => {
    const store = fakeStore({ canonical: { 'x.com': {} }, blocked: [] })
    render(<RulesEditor store={store} />)
    const kp = (await screen.findByPlaceholderText('keepParams (comma-separated)')) as HTMLInputElement
    fireEvent.input(kp, { target: { value: 'id, v' } })
    fireEvent.blur(kp)
    await waitFor(() => expect(store.current.canonical['x.com'].keepParams).toEqual(['id', 'v']))
  })

  test('blocking a domain writes through the store', async () => {
    const store = fakeStore({ canonical: {}, blocked: [] })
    render(<RulesEditor store={store} />)
    await screen.findByText('Blocked domains')
    fireEvent.input(screen.getByPlaceholderText('add blocked domain'), { target: { value: 'bank.com' } })
    fireEvent.click(screen.getByText('Block'))
    await waitFor(() => expect(store.current.blocked).toContain('bank.com'))
  })

  test('import rejects invalid JSON with a visible message and does not change state', async () => {
    const store = fakeStore({ canonical: {}, blocked: [] })
    render(<RulesEditor store={store} />)
    const ta = (await screen.findByPlaceholderText('paste ruleset JSON to import')) as HTMLTextAreaElement
    fireEvent.input(ta, { target: { value: '{ not json' } })
    fireEvent.click(screen.getByText('Import'))
    expect(await screen.findByText(/Invalid JSON/i)).toBeTruthy()
    expect(store.current.canonical).toEqual({})
  })

  test('export reflects current rules as JSON', async () => {
    const store = fakeStore({ canonical: { 'x.com': { keepParams: ['id'] } }, blocked: ['a.com'] })
    render(<RulesEditor store={store} />)
    fireEvent.click(await screen.findByText('Export'))
    const out = (await screen.findByLabelText('exported ruleset')) as HTMLTextAreaElement
    expect(JSON.parse(out.value)).toEqual({ canonical: { 'x.com': { keepParams: ['id'] } }, blocked: ['a.com'] })
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/options/RulesEditor.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement RulesEditor**

`src/options/RulesEditor.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks'
import { createRulesetStore, type Ruleset } from '../shared/ruleset'
import type { Store } from '../shared/storage'
import { parseKeepParams, rulesReducer, validateRuleset, type RulesAction } from './rulesReducer'

export function RulesEditor({ store = createRulesetStore() }: { store?: Store<Ruleset> }) {
  const [ruleset, setRuleset] = useState<Ruleset>({ canonical: {}, blocked: [] })
  const [loaded, setLoaded] = useState(false)
  const [newDomain, setNewDomain] = useState('')
  const [newBlocked, setNewBlocked] = useState('')
  const [importText, setImportText] = useState('')
  const [exported, setExported] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void store.load().then((r) => {
      setRuleset(r)
      setLoaded(true)
    })
    return store.watch(setRuleset)
  }, [])

  async function apply(action: RulesAction) {
    const prev = ruleset
    const next = rulesReducer(prev, action)
    setRuleset(next)
    try {
      await store.save(next)
    } catch {
      setRuleset(prev)
      setError('Could not save — try again.')
    }
  }

  async function replaceAll(next: Ruleset) {
    const prev = ruleset
    setRuleset(next)
    try {
      await store.save(next)
    } catch {
      setRuleset(prev)
      setError('Could not save — try again.')
    }
  }

  function doImport() {
    let parsed: unknown
    try {
      parsed = JSON.parse(importText)
    } catch {
      setError('Invalid JSON: could not parse.')
      return
    }
    const result = validateRuleset(parsed)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    void replaceAll(result.value)
  }

  if (!loaded) return <div class="loading">Loading rules…</div>
  const domains = Object.keys(ruleset.canonical)

  return (
    <div class="rules-editor">
      {error && <div class="error" role="alert" onClick={() => setError(null)}>{error}</div>}

      <section>
        <h2>Canonicalization rules</h2>
        <p class="hint">Per-domain overrides applied when a page has no accepted canonical link.</p>
        {domains.map((domain) => {
          const rule = ruleset.canonical[domain]
          return (
            <div class="rule-row" key={domain}>
              <input readOnly value={domain} />
              <input
                placeholder="keepParams (comma-separated)"
                value={(rule.keepParams ?? []).join(', ')}
                onBlur={(e) =>
                  void apply({
                    type: 'setKeepParams',
                    domain,
                    keepParams: parseKeepParams((e.target as HTMLInputElement).value),
                  })
                }
              />
              <input
                placeholder="pathRewrite (e.g. /watch)"
                value={rule.pathRewrite ?? ''}
                onBlur={(e) =>
                  void apply({ type: 'setPathRewrite', domain, pathRewrite: (e.target as HTMLInputElement).value })
                }
              />
              <button onClick={() => void apply({ type: 'removeDomain', domain })}>Remove</button>
            </div>
          )
        })}
        <div class="rule-add">
          <input
            placeholder="add domain, e.g. news.ycombinator.com"
            value={newDomain}
            onInput={(e) => setNewDomain((e.target as HTMLInputElement).value)}
          />
          <button
            onClick={() => {
              const d = newDomain.trim()
              if (d) void apply({ type: 'addDomain', domain: d })
              setNewDomain('')
            }}
          >
            Add domain
          </button>
        </div>
      </section>

      <section>
        <h2>Blocked domains</h2>
        <p class="hint">The extension reports nothing on these domains — no page reaches your realm.</p>
        {ruleset.blocked.map((domain) => (
          <div class="blocked-row" key={domain}>
            <span>{domain}</span>
            <button onClick={() => void apply({ type: 'removeBlocked', domain })}>Unblock</button>
          </div>
        ))}
        <div class="rule-add">
          <input
            placeholder="add blocked domain"
            value={newBlocked}
            onInput={(e) => setNewBlocked((e.target as HTMLInputElement).value)}
          />
          <button
            onClick={() => {
              const d = newBlocked.trim()
              if (d) void apply({ type: 'addBlocked', domain: d })
              setNewBlocked('')
            }}
          >
            Block
          </button>
        </div>
      </section>

      <section>
        <h2>Import / export</h2>
        <div class="io">
          <button onClick={() => setExported(JSON.stringify(ruleset, null, 2))}>Export</button>
          {exported !== null && (
            <textarea aria-label="exported ruleset" readOnly value={exported} rows={6} />
          )}
        </div>
        <div class="io">
          <textarea
            placeholder="paste ruleset JSON to import"
            value={importText}
            onInput={(e) => setImportText((e.target as HTMLTextAreaElement).value)}
            rows={6}
          />
          <button onClick={doImport}>Import</button>
        </div>
      </section>
    </div>
  )
}
```

- [ ] **Step 4: Mount in OptionsView**

In `src/options/OptionsView.tsx`, import and render the editor after the two existing sections. Add the import:

```tsx
import { RulesEditor } from './RulesEditor'
```

and just before the closing `</div>` of `.options`, add:

```tsx
      <RulesEditor />
```

- [ ] **Step 5: Append styles**

Append to `src/options/options.css`:

```css
.rules-editor section { margin: 24px 0; }
.rules-editor h2 { font-size: 16px; margin-bottom: 4px; }
.rule-row, .blocked-row, .rule-add, .io { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
.rule-row input { flex: 1 1 140px; padding: 4px; }
.rule-row input[readonly] { background: #f0f0f0; }
.blocked-row span { flex: 1; }
.io textarea { flex: 1 1 100%; font-family: ui-monospace, monospace; font-size: 12px; }
.rules-editor .error { background: #fdecea; color: #b3261e; padding: 8px; cursor: pointer; }
```

- [ ] **Step 6: Run to verify green + build**

Run: `npx vitest run src/options/RulesEditor.test.tsx`
Expected: PASS (6 tests).
Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/options/RulesEditor.tsx src/options/RulesEditor.test.tsx src/options/OptionsView.tsx src/options/options.css
git commit -m "feat: rules editor with per-domain rules, block-list, and JSON import/export"
```

---

### Task 6: OptionsView save error handling (backlog carry)

**Files:**
- Modify: `src/options/OptionsView.tsx`
- Modify: `src/options/OptionsView.test.tsx` (append one test)

**Interfaces:** unchanged.

- [ ] **Step 1: Append the failing test**

Append inside the describe in `src/options/OptionsView.test.tsx`:

```tsx
  test('a failed save reverts the toggle and shows an error', async () => {
    const store = fakeStore()
    store.save = async () => {
      throw new Error('quota')
    }
    render(<OptionsView store={store} />)
    const strict = (await screen.findByLabelText(/Strict privacy/i)) as HTMLInputElement
    fireEvent.click(strict)
    await waitFor(() => expect(screen.getByText(/Could not save/i)).toBeTruthy())
    expect(strict.checked).toBe(false) // reverted
  })
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/options/OptionsView.test.tsx`
Expected: the new test FAILS (no revert / no error text today).

- [ ] **Step 3: Implement**

In `src/options/OptionsView.tsx`, add an `error` state and make `update` revert on failure. Replace the `update` function and add error state + render:

```tsx
  const [error, setError] = useState<string | null>(null)

  async function update(patch: Partial<Settings>) {
    const prev = settings
    setSettings({ ...settings, ...patch })
    try {
      await store.save(patch)
    } catch {
      setSettings(prev)
      setError('Could not save — try again.')
    }
  }
```

And render the error just under the `<h1>`:

```tsx
      {error && <div class="error" role="alert" onClick={() => setError(null)}>{error}</div>}
```

(Add an `.error` rule to `options.css` if not already present:)

```css
.options .error { background: #fdecea; color: #b3261e; padding: 8px; margin: 8px 0; cursor: pointer; }
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/options/OptionsView.test.tsx && npx tsc --noEmit`
Expected: PASS (existing 3 + 1 new).

- [ ] **Step 5: Commit**

```bash
git add src/options/OptionsView.tsx src/options/OptionsView.test.tsx src/options/options.css
git commit -m "fix: options settings save reverts and surfaces an error on failure"
```

---

### Task 7: Strict-privacy gate settings-ordering + remove dead checkedRef (backlog carries)

**Files:**
- Modify: `src/panel/resolveGate.ts`, `src/panel/resolveGate.test.ts`, `src/panel/App.tsx`

**Interfaces:**
- Produces: `shouldGate(resolveMode: 'auto' | 'manual'): boolean` (single arg now).

- [ ] **Step 1: Simplify shouldGate (TDD)**

Replace `src/panel/resolveGate.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { shouldGate } from './resolveGate'

describe('shouldGate', () => {
  test('manual mode gates, auto does not', () => {
    expect(shouldGate('manual')).toBe(true)
    expect(shouldGate('auto')).toBe(false)
  })
})
```

Run: `npx vitest run src/panel/resolveGate.test.ts` → FAILS (still 2-arg).

Replace `src/panel/resolveGate.ts`:

```ts
/** True when the panel must wait for an explicit "Check for discussion" click before resolving. */
export function shouldGate(resolveMode: 'auto' | 'manual'): boolean {
  return resolveMode === 'manual'
}
```

Run again → PASS.

- [ ] **Step 2: Update App — remove checkedRef, order the first resolution after settings load**

In `src/panel/App.tsx`:

1. Delete the `checkedRef` ref declaration (`const checkedRef = useRef(false)`).
2. In `applyPush`, the switch branch currently does `checkedRef.current = false` then `if (shouldGate(settingsRef.current.resolveMode, checkedRef.current))`. Change to drop the ref and the reset line:

```ts
    if (action === 'switch' && entity) {
      setError(null)
      setThread(null)
      setEditState(null)
      dispatch({ type: 'history', messages: [] })
      setDraftText(drafts.get(entity.entityUri))
      if (shouldGate(settingsRef.current.resolveMode)) {
        setPendingEntity(entity)
      } else {
        setPendingEntity(null)
        void resolveEntity(entity)
      }
    } else if (action === 'clear') {
```

3. In `checkForDiscussion`, remove the `checkedRef.current = true` line (it is now dead) — the function just clears `pendingEntity` and calls `resolveEntity`:

```ts
  function checkForDiscussion() {
    const entity = pendingEntity
    if (!entity) return
    setPendingEntity(null)
    void resolveEntity(entity)
  }
```

4. In `resetThreadState`, remove `checkedRef.current = false` (keep `setPendingEntity(null)`).

5. **Settings-load ordering (the structural fix).** Add a `settingsLoadedRef`:

```ts
  const settingsLoadedRef = useRef(false)
```

Set it in the settings effect:

```ts
  useEffect(() => {
    void settingsStore.load().then((s) => {
      settingsRef.current = s
      settingsLoadedRef.current = true
    })
    return settingsStore.watch((s) => (settingsRef.current = s))
  }, [])
```

Guard `applyPush` at its top so a push that arrives before settings are loaded is deferred until they are:

```ts
  function applyPush(entity: PageEntity | null) {
    if (!settingsLoadedRef.current) {
      // Don't resolve anything (which could reveal the page to the realm in
      // strict mode) until we know the user's resolveMode. Re-request shortly.
      window.setTimeout(() => requestActiveEntity(), 50)
      return
    }
    const { state, action } = panelTarget(
      targetRef.current,
      { type: 'push', entity },
      settingsRef.current.onNonWebPage
    )
    // ... rest unchanged ...
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all green (resolveGate test updated; App still builds; existing panel tests unaffected).

- [ ] **Step 4: Commit**

```bash
git add src/panel/resolveGate.ts src/panel/resolveGate.test.ts src/panel/App.tsx
git commit -m "harden: order strict-privacy gate after settings load; remove dead checkedRef"
```

---

### Task 8: Docs, version 0.5.0, checklist

**Files:**
- Modify: `package.json`, `public/manifest.json`, `README.md`

- [ ] **Step 1: Version + docs**

1. `package.json` + `public/manifest.json`: `"version": "0.5.0"`.
2. `README.md` "Current state" line → `**M1d-2** (canonicalization rules, domain block-list, options page; see docs/superpowers/specs/).`
3. `README.md` — after the M1d-1 checklist add:

```markdown
## M1d-2 acceptance checklist

- [ ] Options → Canonicalization rules: add `news.ycombinator.com` with keepParams `id`. Open an HN item URL with extra params (e.g. `?id=123&utm_source=x`) and the clean `?id=123` URL — both resolve to the same thread.
- [ ] Add a `pathRewrite` rule (e.g. youtube.com → `/watch`, keepParams `v`) and confirm a `/watch?v=…&list=…` URL keys on `/watch?v=…`.
- [ ] Blocked domains: add a domain; open a page there → panel shows the no-page state and DevTools Network shows no request to the realm; the SW never learns the page. Unblock → resolution returns (may need a reload/navigation).
- [ ] Export produces JSON of the current ruleset; Import of that JSON round-trips; Import of malformed JSON shows an error and changes nothing.
- [ ] (If you use Chrome sign-in across profiles) a rule added in one profile appears in another — rules live in storage.sync.
- [ ] Strict privacy still gates correctly (the gate now waits for settings to load before resolving).
```

- [ ] **Step 2: Verify and commit**

Run: `npm run build && npm test && npx tsc --noEmit` — all green.

```bash
git add package.json public/manifest.json README.md
git commit -m "docs: M1d-2 acceptance checklist; version 0.5.0"
```

---

## Plan self-review notes

- **Spec coverage:** ruleset store + isBlocked (T1), canonicalize step 3 (T2), content-script rules+block (T3), rules reducer + validate (T4), editor UI + import/export + mount (T5), options save error handling (T6), strict-gate ordering + checkedRef removal (T7), docs/version (T8). All spec sections placed; deferred items (versioning, inbound-move, sanitizer spans, badge) explicitly out.
- **Type consistency:** `CanonicalRule`/`Ruleset` (T1) used in T2/T4/T5; `canonicalize(href, canonicalHref, canonical?)` (T2) matches T3's content-script call; `RulesAction`/`validateRuleset`/`parseKeepParams` (T4) match T5's usage; `shouldGate` single-arg (T7) matches its only caller (App).
- **Additive canonicalize:** T2's 3rd param is optional; the panel/topic paths that call `canonicalize` indirectly are unaffected (only the content script passes a ruleset).
- **`createStore` reuse:** ruleset uses the same generic store as settings/credentials; the only difference is the default area (`storage.sync`), passed through the factory's default args.
- **Thread-split limitation** is documented in the spec (client-side rules per-user); not engineered away in M1d-2 by design.

# PageThreads M1d-2 — Resolver Rules + Domain Block-List Design

**Date:** 2026-07-14
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §4.3 (Tier-1 rules), §4.4 (per-domain overrides), §4.5 (versioning — deferred), §7 (domain block-list), §9 (settings). Second of three M1d chunks (M1d-1 ✓ → **M1d-2 rules + block-list** → M1d-3 unread badge). M1 completes at the end of M1d-3.

## Goal

Let users refine URL canonicalization per domain and block domains entirely, edited from the options page — plus the high-value M1d-1 review carries.

## Scope

In:
- `ruleset` store on `chrome.storage.sync`: `{ canonical: Record<domain, {keepParams?, pathRewrite?}>, blocked: string[] }`.
- Canonicalization step 3 (§4.4): `applyDomainRules` composed into `canonicalize` via an optional ruleset arg.
- Content-script flow: load ruleset, bail (send no `pageEntity`) on blocked domains, else canonicalize with rules; re-read on ruleset change.
- Options page: structured rules editor (add/remove domain rows: keepParams + pathRewrite) with JSON export/import; blocked-domains editor. Pre-seeded block-list defaults.
- Backlog carries: structural strict-privacy gate (defer first resolution until settings load); remove dead `checkedRef`; OptionsView save error handling.

Out (deferred, documented): resolver versioning/migration (§4.5 — M2); tool-specific Tier-1/Tier-2 resolvers (Jira/GitHub/etc — Appendix A, later); messageMoved inbound/cross-channel; sanitizer colspan/rowspan; unread badge (M1d-3).

## Design

### Ruleset store (`src/shared/ruleset.ts`)

```ts
interface CanonicalRule { keepParams?: string[]; pathRewrite?: string }
interface Ruleset { canonical: Record<string, CanonicalRule>; blocked: string[] }
const DEFAULT_RULESET: Ruleset = { canonical: {}, blocked: [<pre-seeded examples>] }
createRulesetStore(area?, changed?, areaName?): Store<Ruleset>  // default area chrome.storage.sync, areaName 'sync'
```

Built on the existing generic `createStore` (serialized writes; chrome APIs only as default args). Rules live in `storage.sync` so they roam across the user's Chrome profiles (§4.4). Pre-seeded `blocked` defaults are a short, clearly-example set (e.g. two placeholder banking/health domains) the user can clear/extend; documented as examples, not an exhaustive privacy guarantee.

`isBlocked(domain: string, blocked: string[]): boolean` — pure; registrable-domain match (exact or the domain is a suffix segment match), used by the content script.

### Canonicalization step 3 (`src/shared/canonicalize.ts`)

- New pure `applyDomainRules(url: string, canonical: Record<string, CanonicalRule>): string`:
  - Resolve the URL's registrable domain (existing `tldts.getDomain`); look up its rule. No rule → return `url` unchanged.
  - `pathRewrite` (if present): replace `pathname` with the given value.
  - `keepParams` (if present): drop every query param not in the list (applied to the already-tracking-stripped, sorted query from step 2). Absent keepParams → query unchanged.
- `canonicalize(href, canonicalHref, ruleset?)` — new optional 3rd param. When omitted, behaves exactly as today (all existing callers/tests unaffected). When present, step 2's output is passed through `applyDomainRules(_, ruleset.canonical)` before returning. Precedence: canonical-link acceptance (step 1) still short-circuits; domain rules apply only on the normalization path (step 2→3), matching §4.4's ordering.

### Content script (`src/content/index.ts`)

- On load: `await rulesetStore.load()` (from `storage.sync`), then compute the page's registrable domain.
- If `isBlocked(domain, ruleset.blocked)` → send nothing, register no watchers (bail). (Pragmatic §7: `<all_urls>` injection can't be revoked per-page without a dynamic manifest, so the script runs but reports nothing — no `pageEntity`, so the SW never learns the page and the panel shows the no-page state.)
- Else: resolve via `canonicalize(location.href, canonicalHref, ruleset)` and report as today; the nav-watcher's `resolve()` closure captures the current ruleset.
- `rulesetStore.watch` re-reads on change: a newly-blocked active domain stops reporting (next nav or a one-shot re-eval), a new canonical rule re-resolves on next nav. (Full live re-resolution of the current page on rule change is a nicety; M1d-2 re-resolves on the next navigation, documented.)

### Options page (`src/options/`)

The M1d-1 `OptionsView` grows; split into sections for clarity:
- **General** (existing two toggles).
- **Canonicalization rules**: `RulesEditor.tsx` — a row per domain (`domain` text, `keepParams` comma/tag input, `pathRewrite` text), Add/Remove; backed by a pure `rulesReducer` (`src/options/rulesReducer.ts`). **Export** serializes `canonical` to pretty JSON (textarea + copy); **Import** parses+validates JSON and replaces `canonical`.
- **Blocked domains**: a simple add/remove list bound to `ruleset.blocked`.
- All writes go through `rulesetStore.save(...)`; the M1d-1 optimistic-update pattern gains a `.catch` that reverts and shows an inline error (backlog item).
- Pure `validateRuleset(raw: unknown): { ok: true; value: Ruleset } | { ok: false; error: string }` — guards import and any parse; rejects bad JSON, non-object, non-array `keepParams`, non-string `pathRewrite`, non-array `blocked`.

### Backlog carries

1. **Structural strict-privacy gate** — App currently initializes `settingsRef` to defaults and loads async; the first `activeEntity` push could (theoretically) beat the load and auto-resolve for a strict-mode user. Fix: gate the panel's first resolution on settings being loaded — the port's `getActiveEntity` request (or the first `applyPush`) waits until `settingsStore.load()` resolves. Small ordering change; privacy then rests on structure, not timing.
2. **Remove dead `checkedRef`** — `shouldGate`'s second arg is always `false` in practice (set false then read two lines later; the `true` write is never observed because `panelTarget` dedups same-URI pushes). Delete `checkedRef` and simplify `shouldGate` to a single arg `shouldGate(resolveMode): boolean` (returns `resolveMode === 'manual'`); update its test.
3. **OptionsView save error handling** — the optimistic `setSettings(next)` before an unawaited `save()` has no rollback; add `.catch(() => { setSettings(prev); setError(...) })` (applies to the settings toggles and the new ruleset writes).

## Testing

- Unit: `applyDomainRules` (keepParams narrowing incl. drop-all when empty list, pathRewrite, no-rule passthrough, §4.4 HN-`id` and YouTube-`/watch` vectors); `canonicalize` with ruleset (step-3 composition, canonical-link still short-circuits, precedence vs tracking strip); `isBlocked` (exact + registrable-domain match, non-match); `validateRuleset` (bad JSON, wrong shapes, arrays); `rulesReducer` (add/edit/remove domain, keepParams edit, add/remove blocked); `shouldGate` single-arg; settings/ruleset store round-trips on their areas.
- Component: `RulesEditor` renders rows, add/remove writes through the store; import rejects bad JSON with a visible message and leaves state unchanged; export reflects current rules; blocked-domains add/remove.
- Manual checklist: add `keepParams:[id]` for `news.ycombinator.com` → an HN item URL with extra params keys the same thread as the clean `?id=` URL; add a `pathRewrite` rule and confirm; block a domain → open its page → panel shows "Open a web page…" / no-page state and DevTools shows no `pageEntity`/no realm request; unblock → resolves again; export → import round-trips; edit a rule in one profile, confirm it appears in another signed-in-to-Chrome profile (or document sync); strict-privacy still gates correctly with the structural change; a rapid A→B→A no longer depends on `checkedRef`.

## Acceptance

1. A per-domain `keepParams`/`pathRewrite` rule changes canonicalization so matching pages key on the intended URL; the §4.4 examples pass as unit vectors and manually.
2. A blocked domain produces no `pageEntity` and no realm contact; unblocking restores resolution.
3. Rules are editable via the structured form and via JSON import/export, with validation rejecting malformed input.
4. The three backlog carries land: strict-privacy gate is settings-load-ordered, `checkedRef` is gone, options saves handle failure.
5. Version 0.5.0; all existing 191 tests keep passing.

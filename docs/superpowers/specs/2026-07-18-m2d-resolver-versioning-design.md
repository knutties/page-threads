# PageThreads M2d — Resolver Versioning Contract

**Date:** 2026-07-18
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §4.5 (Versioning), §4.6 (header message format), Appendix B (the header + entityUri grammar are versioned contracts the future knowledge-index consumes). Fourth sub-project of **M2** (Robust), after M2a/M2b/M2c (merged at v0.8.1).

## Context

Today there is exactly one resolver — the generic **web** resolver (`canonicalize` + a `web:` prefix), modified by the user's canonical ruleset — and the header message hardcodes the literal string `"resolver web@1"` (`src/panel/App.tsx`). There is no structured resolver identity, so a future §4.4 algorithm change or a second resolver has nowhere to record its version. Appendix B binds the header message and entityUri grammar as versioned contracts, so making the resolver's identity structured is durable, forward-compatible groundwork.

The full §4.5 also specifies drift detection — when a re-key orphans a thread, resolve both keys and show the old thread read-only. That half is **deferred** (see Non-goals): its only trigger today is a user ruleset edit, and it needs prior-ruleset retention + a new read-only panel mode. This chunk builds the versioning contract those mechanisms will sit on.

## Goal

Make resolution produce and record a structured `{resolverId, resolverVersion}` — replacing the hardcoded `web@1` in the header message with values sourced from the resolver — so resolver identity is a real, forward-compatible contract, with no change to today's output.

## Scope

In:
- A resolver-descriptor module owning the web resolver's identity (`RESOLVER_ID`, `RESOLVER_VERSION`) and a `resolveWebEntity` that returns `{entityUri, resolverId, resolverVersion}`.
- `PageEntity` carries `resolverId` and `resolverVersion`; the content script attaches them; the SW passes them through.
- The header message records `${resolverId}@${resolverVersion}` (extracted to a testable pure module).

Out (explicit non-goals — deferred, bound backlog item):
- **Drift detection & the read-only "earlier discussion" merge view** — retain the prior ruleset, dual-resolve old vs new topicKey on a re-key, detect a thread under the old key, render it read-only. To be built when a resolver version actually bumps or rule-edit orphaning proves a real problem.
- **Ruleset-generation recording in the header** — needed by drift detection; deferred with it.
- No new resolver (jira/gdrive/github Tier-1 resolvers remain future work); no behavior change (today's header output stays `web@1`).

## Design

### 1. Resolver descriptor (`src/shared/resolver.ts` — new)

```ts
import { canonicalize, type CanonicalRule } from './canonicalize'

export const RESOLVER_ID = 'web'
/**
 * The §4.4 web-canonicalization algorithm version. Bump this DELIBERATELY when
 * the algorithm changes in a way that re-keys existing threads (a versioned act
 * per §4.5) — never automatically.
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
This is the single home for the web resolver's identity + the `web:` prefix (previously inline in the content script).

### 2. `PageEntity` carries the descriptor

- **`src/shared/messages.ts`** — `PageEntity` gains two required fields:
  ```ts
  export interface PageEntity {
    entityUri: string
    title: string
    resolverId: string
    resolverVersion: number
  }
  ```
  (`ContentToSw`'s `pageEntity` variant and `SwToPanel`'s `activeEntity` already spread `PageEntity`, so they carry the fields automatically.)
- **`src/content/index.ts`** — `resolveUri()` delegates to `resolveWebEntity(...).entityUri` (keeping the `web:` prefix in one place). Every reported entity is a `web:` one (blocked domains send `pageBlocked`, never a `PageEntity`), so `report(...)` and the `queryEntity` `sendResponse(...)` attach the constants `resolverId: RESOLVER_ID, resolverVersion: RESOLVER_VERSION`. `navWatcher` stays string-based (it dedupes on the entityUri string); the descriptor is attached at report time.
- **`src/background/index.ts`** — the `pageEntity` message handler currently reconstructs `tabEntities.set(tabId, { entityUri: msg.entityUri, title: msg.title })`; extend it to include `resolverId: msg.resolverId, resolverVersion: msg.resolverVersion`. `entityForTab`'s `queryEntity` reply is returned whole (already carries the fields); the `activeEntity` broadcast passes the entity object through unchanged. No other SW change.

### 3. Header records the descriptor (`src/panel/headerMessage.ts` — extracted + tested)

Move the private `headerMessage(entity, email)` out of `App.tsx` into its own pure module and source the resolver tag from the entity:
```ts
import type { PageEntity } from '../shared/messages'

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
`App.tsx` imports it instead of defining it. Output is byte-identical for a `web@1` entity today, but a future version bump now flows through automatically.

### 4. Test-fixture ripple

`PageEntity` becoming stricter (two new required fields) will surface `tsc` errors at any test/fixture that constructs a `PageEntity` (e.g. panel/SW tests). Each such fixture adds `resolverId: 'web', resolverVersion: 1`. These are mechanical type-satisfaction updates, not behavioral changes.

## Testing

- **Unit — `resolver.test.ts` (new):** `resolveWebEntity('https://example.com/a', null)` → `{ entityUri: 'web:https://example.com/a', resolverId: 'web', resolverVersion: 1 }`; a canonical rule is applied (e.g. `keepParams`) via the delegated `canonicalize`; `RESOLVER_ID`/`RESOLVER_VERSION` exported as `'web'`/`1`.
- **Unit — `headerMessage.test.ts` (new):** for an entity `{ entityUri: 'web:https://x.com/a', title: 'X', resolverId: 'web', resolverVersion: 1 }` the output contains `(resolver web@1)`, strips `web:` in the `Link:` line, and matches the exact 4-line §4.6 format; a hypothetical `{ resolverId: 'web', resolverVersion: 2 }` renders `(resolver web@2)` — proving the tag is sourced from the entity, not hardcoded.
- Existing tests: updated only where a `PageEntity` fixture needs the two new fields (mechanical); no assertions weakened. Full suite stays green.

## Acceptance

1. Resolution produces a structured `{resolverId, resolverVersion}`; `PageEntity` carries them from the content script through the SW to the panel.
2. The header message records `${resolverId}@${resolverVersion}` sourced from the entity (a `resolverVersion: 2` entity would render `web@2`); today's output is unchanged (`web@1`).
3. `RESOLVER_VERSION` is a single deliberate constant (a §4.4 algorithm change bumps it as a versioned act).
4. Drift detection + the read-only merge view are **not** built (deferred backlog); no behavior change beyond the structured header sourcing.
5. Version 0.8.2; new unit tests for `resolveWebEntity` and `headerMessage` pass; the suite stays green (fixtures updated for the new required fields).

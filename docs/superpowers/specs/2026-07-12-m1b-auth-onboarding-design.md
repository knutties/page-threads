# PageThreads M1b — Auth & Onboarding Design

**Date:** 2026-07-12
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §5 (auth API), §7 (credential storage), §9 (settings surface). Second of four M1 sub-projects (M1a live-panel UX ✓ → **M1b auth** → M1c message features → M1d rules/badge).

## Goal

Retire the hardcoded `src/config.ts`: users configure realm + account inside the side panel, credentials live in extension storage, and the extension supports both password sign-in and API-key paste.

## Scope

In:
- In-panel onboarding (SetupView) and a gear/account view (who am I, realm, sign out).
- Auth methods: email+password → `POST /api/v1/fetch_api_key`; manual API-key paste validated via `GET /api/v1/users/me`. SSO realms: documented pointer to the key-paste flow (README).
- Credentials record in `chrome.storage.local`: `{ realmUrl, email, apiKey, channelName }`.
- Realm URL normalization (origin only) + reachability/auth-methods probe via `GET /api/v1/server_settings`.
- Channel name editable at setup (default `web-threads`), validated via `getStreamId` before save.
- Storage-layer generalization shared by settings + credentials, **fixing the `save()` read-merge-write race** (per-store serialized write queue).
- Service worker reads credentials from storage; `credentialsChanged` signal restarts/stops the event loop on sign-in/sign-out.
- Removal of `src/config.ts`, `src/config.example.ts`, and their gitignore/README references.
- Docs cleanup: the `dist-user2` second-build workflow is obsolete (both dev profiles run the same `dist/` and sign in as different users); update README + dev/zulip/README and simplify `dev/run-chrome.sh` usage notes accordingly.

Out (later chunks): options page (M1d), per-domain rules, badge, Markdown, edit/delete/reactions, multi-realm, SSO browser-flow automation, `storage.session`/encrypted key storage (documented §7 threat model stands).

## Design

### Storage layer (`src/shared/storage.ts`, refactor of settings.ts internals)

A generic `createStore<T>(key, defaults, area?, changed?, areaName?)` with `load / save / watch` and one addition over M1a's settings store: **`save` calls are serialized per store** through an internal promise chain, closing the read-merge-write race (two rapid saves of different fields can no longer drop one another). `settings.ts` re-exports its existing API on top of this; new `src/shared/credentials.ts`:

```ts
interface Credentials { realmUrl: string; email: string; apiKey: string; channelName: string }
credentialsStore: load(): Promise<Credentials | null>  // null = not configured
                  save(c: Credentials) / clear() / watch(cb)
```

Credentials have no defaults object — absence means "run onboarding". `normalizeRealmUrl(input): string | null` (pure): trims, adds https:// when scheme-less, parses, returns `origin` or null on garbage; http allowed only for localhost/127.0.0.1 (dev realms; matches Chrome's secure-context rules).

### Zulip API additions (`zulipClient.ts`)

- `static probeServer(realmUrl, fetchFn?): Promise<ServerSettings>` — `GET /api/v1/server_settings` (unauthenticated): returns `{ requiresPassword: boolean, realmName: string, zulipVersion: string }` derived from `authentication_methods`/`external_authentication_methods` (password available ⇔ `password` backend enabled).
- `static fetchApiKey(realmUrl, email, password, fetchFn?): Promise<string>` — `POST /api/v1/fetch_api_key` (form-encoded username/password; no auth header).
- `getOwnUser(): Promise<{ email: string; fullName: string }>` — `GET /api/v1/users/me`, used to validate pasted keys and to show "signed in as" in the account view.

### Setup flow (panel)

Pure reducer `src/panel/setupFlow.ts` drives `SetupView`:

```
steps: 'realm' → 'auth' → 'channel-error'? → done
state: { step, realmUrl, serverInfo, busy, error, authTab: 'password' | 'apikey' }
events: realmSubmitted / probeOk / probeFailed / authSubmitted / authOk / authFailed /
        channelOk / channelMissing / back
```

Flow: realm URL → probe (`server_settings`; on TypeError over https, hint about self-signed certs) → auth step shows Sign in tab only when `requiresPassword` is available, API-key tab always → on auth success validate `getStreamId(channelName)` (channel field lives on the auth step, prefilled `web-threads`) → save credentials → notify SW (`credentialsChanged`) → App proceeds to the normal thread view. Channel missing is a dedicated error state with "ask your Zulip admin to create #<name>" copy and a retry.

### App integration

- App boots: `credentialsStore.load()` → null ⇒ render `SetupView`; else construct `ZulipClient(credentials)` and proceed exactly as today.
- `ZulipClient` construction moves from module level into state (created on load / after setup / after account change).
- Header gains a gear button → `AccountView`: realm, "signed in as <fullName> (<email>)", channel, Sign out. Sign out: `credentialsStore.clear()` + `credentialsChanged` → SetupView.
- Changing realm = sign out + setup from step 1 (per §9: changing realm resets state).

### Service worker

- No more `import { config }`: event loop starts only after `credentialsStore.load()` returns non-null; client + channel name come from storage.
- New runtime message `{type: 'credentialsChanged'}` (panel → SW): SW stops the loop, re-reads credentials, restarts if configured and a port is connected. Port connect with no credentials: SW replies to `getActiveEntity` normally but starts no loop.
- `credentialsStore.watch` also runs in the SW as a belt-and-braces (storage.onChanged), so a missed message can't leave a stale loop.

### Security posture (WHAT.md §7)

- API key only in `chrome.storage.local` (extension-scoped, not page-accessible); password held only in a local variable during `fetch_api_key`, never stored, form field cleared after submit.
- All authenticated calls pinned to the stored `realmUrl` origin.
- Documented: profile access ⇒ key access (same threat model as Zulip web cookies).

## Testing

- Unit (Vitest): `normalizeRealmUrl` table (scheme-less, paths stripped, http-non-localhost rejected, garbage → null); store write-queue (two concurrent saves of different fields → both land; interleaved load sees consistent state); `setupFlow` reducer (full happy path both auth tabs, probe failure, auth failure, channel-missing loop, back navigation); `probeServer`/`fetchApiKey`/`getOwnUser` against fake fetch (endpoint shapes, no auth header on the static calls, form encoding of password).
- Manual checklist: fresh profile onboarding via password; via key paste; wrong password message; unreachable/typo realm URL; self-signed-cert hint appears; missing channel error + retry after creating it; sign out → sign in as a different user → event loop follows (live updates arrive for the new account); credentials survive browser restart.

## Acceptance

1. A fresh profile (no `config.ts` anywhere in the tree) can onboard to the dev realm via password and via key paste, and reach a working thread view.
2. Sign-out returns to setup; signing in as a different user works without reloading the extension.
3. The `save()` race is closed (unit-proven) and settings/credentials share one storage layer.
4. All existing 89 tests keep passing; new suites green; `src/config.ts` and `config.example.ts` are gone from the repo.

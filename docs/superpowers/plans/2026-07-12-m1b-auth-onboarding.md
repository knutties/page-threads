# PageThreads M1b — Auth & Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire hardcoded `src/config.ts`: in-panel onboarding (password sign-in via `fetch_api_key` or API-key paste), credentials in `chrome.storage.local`, service worker follows sign-in/sign-out.

**Architecture:** A generic serialized-write store (`shared/storage.ts`) underpins both settings and a new credentials store (fixing the M1a `save()` race). `ZulipClient` gains two static, unauthenticated calls (`probeServer`, `fetchApiKey`) and `getOwnUser`. The panel gates on credentials: absent → `SetupView` (pure `setupFlow` reducer, injectable `SetupApi`); present → today's thread view, with the client constructed from stored credentials instead of a module import. The SW builds its event loop from stored credentials and restarts it on a `credentialsChanged` runtime message plus a `storage.onChanged` watch.

**Tech Stack:** Existing stack (TypeScript strict, Vite, Preact, Vitest + @testing-library/preact + happy-dom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-12-m1b-auth-onboarding-design.md`.

## Global Constraints

- Password is used only transiently for `POST /api/v1/fetch_api_key` — never stored, field cleared after submit.
- Credentials `{ realmUrl, email, apiKey, channelName }` live in `chrome.storage.local` under key `credentials`; absence = onboarding.
- `normalizeRealmUrl`: origin only; https always allowed; http only for `localhost` / `127.0.0.1`; anything else → null.
- Default channel name: `web-threads`.
- `src/shared/*` keeps chrome APIs only as default parameter values (M1a pattern).
- The `save()` read-merge-write race must be closed with a serialized write queue (unit-proven).
- Existing 89 tests keep passing; the 5 existing settings tests must pass UNCHANGED (proof the refactor preserves the API).
- Version bumps to `0.2.0` in `package.json` and `public/manifest.json` (Task 8).
- Branch `m1b-auth-onboarding` off main. Commit messages end with the repo's two trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LpgtuXYp32egiB82M3qkAb`

---

### Task 1: Generic serialized-write store; settings refactored onto it

**Files:**
- Create: `src/shared/storage.ts`
- Modify: `src/shared/settings.ts` (replace entire file)
- Test: `src/shared/storage.test.ts` (new); `src/shared/settings.test.ts` must pass UNCHANGED

**Interfaces:**
- Produces (consumed by Tasks 2, 6, 7):

```ts
interface StorageAreaLike { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> }
type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void
interface StorageChangedLike { addListener(cb: ChangeListener): void; removeListener(cb: ChangeListener): void }
interface Store<T> { load(): Promise<T>; save(patch: Partial<T>): Promise<void>; watch(cb: (value: T) => void): () => void }
function createStore<T extends object>(key: string, defaults: T, area?: StorageAreaLike, changed?: StorageChangedLike, areaName?: string): Store<T>
```

`settings.ts` keeps exporting `Settings`, `DEFAULT_SETTINGS`, `SettingsStore`, `createSettingsStore(area?, changed?, areaName?)` with identical behavior.

- [ ] **Step 1: Write the failing tests**

`src/shared/storage.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { createStore, type ChangeListener } from './storage'

function fakeStorage(initial: Record<string, unknown> = {}, getDelayMs = 0) {
  const data: Record<string, unknown> = { ...initial }
  const listeners = new Set<ChangeListener>()
  const area = {
    get: async (key: string) => {
      if (getDelayMs) await new Promise((r) => setTimeout(r, getDelayMs))
      return key in data ? { [key]: data[key] } : {}
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items)
      for (const l of listeners) {
        l(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])), 'local')
      }
    },
  }
  const changed = {
    addListener: (l: ChangeListener) => listeners.add(l),
    removeListener: (l: ChangeListener) => listeners.delete(l),
  }
  return { area, changed, data }
}

describe('createStore', () => {
  test('load merges stored partial over defaults', async () => {
    const { area, changed } = fakeStorage({ t: { a: 5 } })
    const store = createStore('t', { a: 0, b: 'x' }, area, changed)
    expect(await store.load()).toEqual({ a: 5, b: 'x' })
  })

  test('CONCURRENT saves of different fields both land (M1a race)', async () => {
    const { area, changed, data } = fakeStorage({}, 5)
    const store = createStore('t', { a: 0, b: 0 }, area, changed)
    await Promise.all([store.save({ a: 1 }), store.save({ b: 2 })])
    expect(data.t).toEqual({ a: 1, b: 2 })
  })

  test('a failed save does not wedge the queue', async () => {
    const { area, changed, data } = fakeStorage()
    let failNext = true
    const flakyArea = {
      get: area.get,
      set: async (items: Record<string, unknown>) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        return area.set(items)
      },
    }
    const store = createStore('t', { a: 0 }, flakyArea, changed)
    await expect(store.save({ a: 1 })).rejects.toThrow('disk full')
    await store.save({ a: 2 })
    expect(data.t).toEqual({ a: 2 })
  })

  test('watch fires with merged value on matching area; unsubscribe stops it', async () => {
    const { area, changed } = fakeStorage()
    const store = createStore('t', { a: 0, b: 'x' }, area, changed, 'local')
    const seen: unknown[] = []
    const unsub = store.watch((v) => seen.push(v))
    await area.set({ t: { a: 3 } })
    expect(seen).toEqual([{ a: 3, b: 'x' }])
    unsub()
    await area.set({ t: { a: 4 } })
    expect(seen).toHaveLength(1)
  })

  test('watch ignores other keys and other areas', async () => {
    const { area, changed } = fakeStorage()
    const store = createStore('t', { a: 0 }, area, changed, 'sync')
    const seen: unknown[] = []
    store.watch((v) => seen.push(v))
    await area.set({ t: { a: 1 } }) // fires as 'local', store watches 'sync'
    await area.set({ other: 1 })
    expect(seen).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/storage.test.ts`
Expected: FAIL — cannot resolve `./storage`.

- [ ] **Step 3: Implement**

`src/shared/storage.ts`:

```ts
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export type ChangeListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string
) => void

export interface StorageChangedLike {
  addListener(cb: ChangeListener): void
  removeListener(cb: ChangeListener): void
}

export interface Store<T> {
  load(): Promise<T>
  save(patch: Partial<T>): Promise<void>
  watch(cb: (value: T) => void): () => void
}

/**
 * Typed key in a chrome.storage-like area with defaults, change watching, and
 * SERIALIZED read-merge-write saves (concurrent saves of different fields must
 * both land — reviewed race from M1a). chrome.* appears only as default
 * arguments so Node tests can inject fakes.
 */
export function createStore<T extends object>(
  key: string,
  defaults: T,
  area: StorageAreaLike = chrome.storage.local,
  changed: StorageChangedLike = chrome.storage.onChanged,
  areaName = 'local'
): Store<T> {
  let writeChain: Promise<void> = Promise.resolve()

  async function load(): Promise<T> {
    const stored = (await area.get(key))[key] as Partial<T> | undefined
    return { ...defaults, ...stored }
  }

  return {
    load,
    save(patch) {
      const next = writeChain.then(async () => {
        const current = await load()
        await area.set({ [key]: { ...current, ...patch } })
      })
      // A rejected save must not wedge the queue for later saves.
      writeChain = next.catch(() => {})
      return next
    },
    watch(cb) {
      const listener: ChangeListener = (changes, name) => {
        if (name === areaName && changes[key]) {
          cb({ ...defaults, ...(changes[key].newValue as Partial<T> | undefined) })
        }
      }
      changed.addListener(listener)
      return () => changed.removeListener(listener)
    },
  }
}
```

`src/shared/settings.ts` (replace entire file):

```ts
import {
  createStore,
  type StorageAreaLike,
  type StorageChangedLike,
  type Store,
} from './storage'

export interface Settings {
  /** Panel behavior when the active tab has no web entity (chrome://, new tab). */
  onNonWebPage: 'hold' | 'clear'
}

export const DEFAULT_SETTINGS: Settings = {
  onNonWebPage: 'hold',
}

export type SettingsStore = Store<Settings>

export function createSettingsStore(
  area?: StorageAreaLike,
  changed?: StorageChangedLike,
  areaName = 'local'
): SettingsStore {
  return createStore('settings', DEFAULT_SETTINGS, area, changed, areaName)
}
```

Note: `createSettingsStore()` with no args must still work in the panel — `createStore`'s own chrome defaults only apply when the argument is `undefined`, which is exactly what happens here.

- [ ] **Step 4: Run tests to verify they pass — settings tests UNCHANGED**

Run: `npx vitest run src/shared/storage.test.ts src/shared/settings.test.ts`
Expected: PASS (5 new + 5 existing). `git diff src/shared/settings.test.ts` must be empty.
Then: `npx tsc --noEmit && npm test` — all green (94 total).

- [ ] **Step 5: Commit**

```bash
git add src/shared/storage.ts src/shared/storage.test.ts src/shared/settings.ts
git commit -m "feat: generic serialized-write store; settings refactored onto it (closes save race)"
```

---

### Task 2: Credentials store + realm URL normalization

**Files:**
- Create: `src/shared/credentials.ts`
- Test: `src/shared/credentials.test.ts`

**Interfaces:**
- Consumes: `StorageAreaLike`, `StorageChangedLike`, `ChangeListener` from Task 1.
- Produces (consumed by Tasks 5–7):

```ts
interface Credentials { realmUrl: string; email: string; apiKey: string; channelName: string }
interface CredentialsStore {
  load(): Promise<Credentials | null>       // null = not configured
  save(c: Credentials): Promise<void>       // whole-record write (no merge, no race)
  clear(): Promise<void>
  watch(cb: (c: Credentials | null) => void): () => void
}
function createCredentialsStore(area?, changed?, areaName?): CredentialsStore
function normalizeRealmUrl(input: string): string | null
```

- [ ] **Step 1: Write the failing tests**

`src/shared/credentials.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { createCredentialsStore, normalizeRealmUrl, type Credentials } from './credentials'
import type { ChangeListener } from './storage'

const CREDS: Credentials = {
  realmUrl: 'https://zulip.example.com',
  email: 'me@x.com',
  apiKey: 'k',
  channelName: 'web-threads',
}

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  const listeners = new Set<ChangeListener>()
  const area = {
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items)
      for (const l of listeners) {
        l(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])), 'local')
      }
    },
  }
  const changed = {
    addListener: (l: ChangeListener) => listeners.add(l),
    removeListener: (l: ChangeListener) => listeners.delete(l),
  }
  return { area, changed, data }
}

describe('credentials store', () => {
  test('load returns null when unconfigured', async () => {
    const { area, changed } = fakeStorage()
    expect(await createCredentialsStore(area, changed).load()).toBeNull()
  })

  test('save/load round-trips; clear returns to null', async () => {
    const { area, changed } = fakeStorage()
    const store = createCredentialsStore(area, changed)
    await store.save(CREDS)
    expect(await store.load()).toEqual(CREDS)
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  test('watch fires with credentials on save and null on clear', async () => {
    const { area, changed } = fakeStorage()
    const store = createCredentialsStore(area, changed)
    const seen: unknown[] = []
    store.watch((c) => seen.push(c))
    await store.save(CREDS)
    await store.clear()
    expect(seen).toEqual([CREDS, null])
  })
})

describe('normalizeRealmUrl', () => {
  test.each([
    ['https://acme.zulipchat.com', 'https://acme.zulipchat.com'],
    ['acme.zulipchat.com', 'https://acme.zulipchat.com'],
    ['https://acme.zulipchat.com/some/path?x=1', 'https://acme.zulipchat.com'],
    ['HTTPS://ACME.ZULIPCHAT.COM', 'https://acme.zulipchat.com'],
    ['http://localhost:9090', 'http://localhost:9090'],
    ['http://127.0.0.1:9090/login', 'http://127.0.0.1:9090'],
    ['  https://acme.zulipchat.com  ', 'https://acme.zulipchat.com'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRealmUrl(input)).toBe(expected)
  })

  test.each([['http://acme.zulipchat.com'], ['ftp://x.com'], [''], ['   '], ['not a url at all::'], ['http://192.168.1.5']])(
    'rejects %s',
    (input) => {
      expect(normalizeRealmUrl(input)).toBeNull()
    }
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/credentials.test.ts`
Expected: FAIL — cannot resolve `./credentials`.

- [ ] **Step 3: Implement**

`src/shared/credentials.ts`:

```ts
import type { ChangeListener, StorageAreaLike, StorageChangedLike } from './storage'

export interface Credentials {
  realmUrl: string
  email: string
  apiKey: string
  channelName: string
}

export interface CredentialsStore {
  load(): Promise<Credentials | null>
  save(c: Credentials): Promise<void>
  clear(): Promise<void>
  watch(cb: (c: Credentials | null) => void): () => void
}

const KEY = 'credentials'

/** Whole-record writes (never merged), so there is no read-merge-write race here. */
export function createCredentialsStore(
  area: StorageAreaLike = chrome.storage.local,
  changed: StorageChangedLike = chrome.storage.onChanged,
  areaName = 'local'
): CredentialsStore {
  return {
    async load() {
      const stored = (await area.get(KEY))[KEY] as Credentials | null | undefined
      return stored ?? null
    },
    async save(c) {
      await area.set({ [KEY]: c })
    },
    async clear() {
      await area.set({ [KEY]: null })
    },
    watch(cb) {
      const listener: ChangeListener = (changes, name) => {
        if (name === areaName && changes[KEY]) {
          cb((changes[KEY].newValue as Credentials | null | undefined) ?? null)
        }
      }
      changed.addListener(listener)
      return () => changed.removeListener(listener)
    },
  }
}

/**
 * Realm input → pinned origin. https only, except plain-http dev realms on
 * localhost/127.0.0.1 (Chrome treats those as secure contexts).
 */
export function normalizeRealmUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    if (u.protocol === 'https:') return u.origin
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return u.origin
    }
    return null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/credentials.test.ts`
Expected: PASS (16 tests). Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/credentials.ts src/shared/credentials.test.ts
git commit -m "feat: credentials store and realm URL normalization"
```

---

### Task 3: ZulipClient — probeServer, fetchApiKey, getOwnUser

**Files:**
- Modify: `src/shared/zulipClient.ts`
- Test: `src/shared/zulipClient.test.ts` (append a describe block; existing 11 tests unchanged)

**Interfaces:**
- Produces (consumed by Task 5):

```ts
interface ServerSettings { passwordAuthEnabled: boolean; realmName: string; zulipVersion: string }
ZulipClient.probeServer(realmUrl: string, fetchFn?: typeof fetch): Promise<ServerSettings>   // static, unauthenticated
ZulipClient.fetchApiKey(realmUrl: string, email: string, password: string, fetchFn?: typeof fetch): Promise<string>  // static, unauthenticated
client.getOwnUser(): Promise<{ email: string; fullName: string }>
```

(Spec calls the first field `requiresPassword`; implemented as `passwordAuthEnabled` — same meaning, more accurate name.)

- [ ] **Step 1: Write the failing tests** (append to `src/shared/zulipClient.test.ts`)

```ts
describe('onboarding endpoints', () => {
  test('probeServer hits /server_settings without auth and maps fields', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fn = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({
          result: 'success',
          authentication_methods: { password: true, dev: false },
          realm_name: 'Acme',
          zulip_version: '12.1',
        })
      )
    }) as typeof fetch
    const s = await ZulipClient.probeServer('https://acme.zulipchat.com', fn)
    expect(s).toEqual({ passwordAuthEnabled: true, realmName: 'Acme', zulipVersion: '12.1' })
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/server_settings')
    expect(calls[0].init).toBeUndefined()
  })

  test('probeServer reports password disabled', async () => {
    const fn = (async () =>
      new Response(
        JSON.stringify({ result: 'success', authentication_methods: { password: false }, realm_name: 'A', zulip_version: 'x' })
      )) as typeof fetch
    expect((await ZulipClient.probeServer('https://a.com', fn)).passwordAuthEnabled).toBe(false)
  })

  test('fetchApiKey posts form-encoded username/password with no auth header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fn = (async (url: any, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ result: 'success', api_key: 'sekrit', email: 'me@x.com' }))
    }) as typeof fetch
    const key = await ZulipClient.fetchApiKey('https://a.com', 'me@x.com', 'hunter2', fn)
    expect(key).toBe('sekrit')
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/fetch_api_key')
    expect(calls[0].init.method).toBe('POST')
    const body = calls[0].init.body as URLSearchParams
    expect(body.get('username')).toBe('me@x.com')
    expect(body.get('password')).toBe('hunter2')
    expect((calls[0].init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined()
  })

  test('fetchApiKey surfaces Zulip error message', async () => {
    const fn = (async () =>
      new Response(JSON.stringify({ result: 'error', msg: 'Your username or password is incorrect', code: 'AUTHENTICATION_FAILED' }), {
        status: 403,
      })) as typeof fetch
    const err = await ZulipClient.fetchApiKey('https://a.com', 'e', 'p', fn).catch((e) => e)
    expect(err).toBeInstanceOf(ZulipError)
    expect(err.message).toBe('Your username or password is incorrect')
  })

  test('getOwnUser maps delivery_email and full_name with basic auth', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fn = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({ result: 'success', email: 'bot@x.com', delivery_email: 'me@x.com', full_name: 'Me Myself' })
      )
    }) as typeof fetch
    const me = await new ZulipClient(cfg, fn).getOwnUser()
    expect(me).toEqual({ email: 'me@x.com', fullName: 'Me Myself' })
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/users/me')
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toContain('Basic ')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/zulipClient.test.ts`
Expected: the 5 new tests FAIL (methods missing); existing 11 pass.

- [ ] **Step 3: Implement** (add to `src/shared/zulipClient.ts`)

Add after the existing response interfaces:

```ts
export interface ServerSettings {
  passwordAuthEnabled: boolean
  realmName: string
  zulipVersion: string
}

export interface GetOwnUserResponse {
  result: 'success'
  msg: string
  email: string
  delivery_email?: string
  full_name: string
}
```

Add a module-level helper above the class (shared by the two static methods):

```ts
async function unauthenticatedRequest(
  realmUrl: string,
  path: string,
  init: RequestInit | undefined,
  fetchFn: typeof fetch
): Promise<any> {
  const f = fetchFn.bind(globalThis)
  const res = await f(new URL(`/api/v1${path}`, realmUrl).toString(), init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.result !== 'success') {
    throw new ZulipError(data.msg ?? `HTTP ${res.status}`, data.code)
  }
  return data
}
```

Add inside the `ZulipClient` class:

```ts
  /** Unauthenticated realm probe (GET /server_settings). */
  static async probeServer(realmUrl: string, fetchFn: typeof fetch = fetch): Promise<ServerSettings> {
    const data = await unauthenticatedRequest(realmUrl, '/server_settings', undefined, fetchFn)
    return {
      passwordAuthEnabled: Boolean(data.authentication_methods?.password),
      realmName: data.realm_name ?? '',
      zulipVersion: data.zulip_version ?? '',
    }
  }

  /** Exchange email+password for an API key (POST /fetch_api_key). Password is not retained. */
  static async fetchApiKey(
    realmUrl: string,
    email: string,
    password: string,
    fetchFn: typeof fetch = fetch
  ): Promise<string> {
    const body = new URLSearchParams({ username: email, password })
    const data = await unauthenticatedRequest(realmUrl, '/fetch_api_key', { method: 'POST', body }, fetchFn)
    return data.api_key
  }

  async getOwnUser(): Promise<{ email: string; fullName: string }> {
    const data = await this.request<GetOwnUserResponse>('GET', '/users/me')
    return { email: data.delivery_email ?? data.email, fullName: data.full_name }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/zulipClient.test.ts`
Expected: PASS (16 tests). Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/zulipClient.ts src/shared/zulipClient.test.ts
git commit -m "feat: server probe, fetch_api_key, and getOwnUser on ZulipClient"
```

---

### Task 4: Setup flow reducer

**Files:**
- Create: `src/panel/setupFlow.ts`
- Test: `src/panel/setupFlow.test.ts`

**Interfaces:**
- Produces (consumed by Task 5):

```ts
interface ServerInfo { passwordAuthEnabled: boolean; realmName: string }
type AuthTab = 'password' | 'apikey'
interface SetupState { step: 'realm' | 'auth'; realmUrl: string; serverInfo: ServerInfo | null; authTab: AuthTab; busy: boolean; error: string | null }
const INITIAL_SETUP: SetupState
type SetupEvent =
  | { type: 'probeStarted' } | { type: 'probeOk'; realmUrl: string; serverInfo: ServerInfo } | { type: 'probeFailed'; message: string }
  | { type: 'tabChanged'; tab: AuthTab } | { type: 'authStarted' } | { type: 'authFailed'; message: string } | { type: 'back' }
function setupReducer(state: SetupState, event: SetupEvent): SetupState
```

Auth success is terminal and handled outside the reducer (the component saves credentials and unmounts).

- [ ] **Step 1: Write the failing tests**

`src/panel/setupFlow.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { INITIAL_SETUP, setupReducer, type SetupState } from './setupFlow'

const INFO = { passwordAuthEnabled: true, realmName: 'Acme' }

function reduce(events: Parameters<typeof setupReducer>[1][], from: SetupState = INITIAL_SETUP) {
  return events.reduce(setupReducer, from)
}

describe('setupReducer', () => {
  test('starts on the realm step, not busy', () => {
    expect(INITIAL_SETUP.step).toBe('realm')
    expect(INITIAL_SETUP.busy).toBe(false)
  })

  test('probe lifecycle: started sets busy, ok advances to auth with server info', () => {
    const s = reduce([
      { type: 'probeStarted' },
      { type: 'probeOk', realmUrl: 'https://a.com', serverInfo: INFO },
    ])
    expect(s).toMatchObject({ step: 'auth', realmUrl: 'https://a.com', serverInfo: INFO, busy: false, error: null })
  })

  test('probeOk defaults the tab to password when available, apikey otherwise', () => {
    expect(reduce([{ type: 'probeOk', realmUrl: 'x', serverInfo: INFO }]).authTab).toBe('password')
    expect(
      reduce([{ type: 'probeOk', realmUrl: 'x', serverInfo: { ...INFO, passwordAuthEnabled: false } }]).authTab
    ).toBe('apikey')
  })

  test('probeFailed stays on realm with the message, clears busy', () => {
    const s = reduce([{ type: 'probeStarted' }, { type: 'probeFailed', message: 'unreachable' }])
    expect(s).toMatchObject({ step: 'realm', busy: false, error: 'unreachable' })
  })

  test('auth lifecycle: started sets busy and clears prior error; failed surfaces message', () => {
    const s = reduce([
      { type: 'probeOk', realmUrl: 'x', serverInfo: INFO },
      { type: 'authStarted' },
      { type: 'authFailed', message: 'bad password' },
    ])
    expect(s).toMatchObject({ step: 'auth', busy: false, error: 'bad password' })
    expect(setupReducer(s, { type: 'authStarted' }).error).toBeNull()
  })

  test('tabChanged switches tab and clears error', () => {
    const s = reduce([
      { type: 'probeOk', realmUrl: 'x', serverInfo: INFO },
      { type: 'authFailed', message: 'nope' },
      { type: 'tabChanged', tab: 'apikey' },
    ])
    expect(s).toMatchObject({ authTab: 'apikey', error: null })
  })

  test('back returns to the realm step, clearing busy and error', () => {
    const s = reduce([
      { type: 'probeOk', realmUrl: 'x', serverInfo: INFO },
      { type: 'authFailed', message: 'channel missing' },
      { type: 'back' },
    ])
    expect(s).toMatchObject({ step: 'realm', busy: false, error: null })
    expect(s.realmUrl).toBe('x') // kept for re-probe convenience
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/panel/setupFlow.test.ts`
Expected: FAIL — cannot resolve `./setupFlow`.

- [ ] **Step 3: Implement**

`src/panel/setupFlow.ts`:

```ts
export interface ServerInfo {
  passwordAuthEnabled: boolean
  realmName: string
}

export type AuthTab = 'password' | 'apikey'

export interface SetupState {
  step: 'realm' | 'auth'
  realmUrl: string
  serverInfo: ServerInfo | null
  authTab: AuthTab
  busy: boolean
  error: string | null
}

export const INITIAL_SETUP: SetupState = {
  step: 'realm',
  realmUrl: '',
  serverInfo: null,
  authTab: 'apikey',
  busy: false,
  error: null,
}

export type SetupEvent =
  | { type: 'probeStarted' }
  | { type: 'probeOk'; realmUrl: string; serverInfo: ServerInfo }
  | { type: 'probeFailed'; message: string }
  | { type: 'tabChanged'; tab: AuthTab }
  | { type: 'authStarted' }
  | { type: 'authFailed'; message: string }
  | { type: 'back' }

/** Pure state machine for SetupView. Auth success is terminal (component unmounts). */
export function setupReducer(state: SetupState, event: SetupEvent): SetupState {
  switch (event.type) {
    case 'probeStarted':
      return { ...state, busy: true, error: null }
    case 'probeOk':
      return {
        ...state,
        step: 'auth',
        realmUrl: event.realmUrl,
        serverInfo: event.serverInfo,
        authTab: event.serverInfo.passwordAuthEnabled ? 'password' : 'apikey',
        busy: false,
        error: null,
      }
    case 'probeFailed':
      return { ...state, step: 'realm', busy: false, error: event.message }
    case 'tabChanged':
      return { ...state, authTab: event.tab, error: null }
    case 'authStarted':
      return { ...state, busy: true, error: null }
    case 'authFailed':
      return { ...state, busy: false, error: event.message }
    case 'back':
      return { ...state, step: 'realm', busy: false, error: null }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/panel/setupFlow.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/panel/setupFlow.ts src/panel/setupFlow.test.ts
git commit -m "feat: pure setup-flow state machine for onboarding"
```

---

### Task 5: SetupView + AccountView components

**Files:**
- Create: `src/panel/SetupView.tsx`, `src/panel/AccountView.tsx`
- Modify: `src/panel/style.css` (append)
- Test: `src/panel/SetupView.test.tsx`, `src/panel/AccountView.test.tsx`

**Interfaces:**
- Consumes: `setupReducer`/`INITIAL_SETUP`/`ServerInfo` (Task 4), `normalizeRealmUrl`/`Credentials` (Task 2), `ZulipClient` statics + `getOwnUser`/`getStreamId` (Task 3).
- Produces (consumed by Task 6):

```ts
interface SetupApi {
  probe(realmUrl: string): Promise<ServerInfo>
  fetchApiKey(realmUrl: string, email: string, password: string): Promise<string>
  validate(creds: Credentials): Promise<void>   // throws Error with user-facing message
}
SetupView({ onComplete: (c: Credentials) => void, api?: SetupApi })   // api defaults to real network impl
AccountView({ credentials: Credentials, fullName?: string, onClose: () => void, onSignOut: () => void })
```

- [ ] **Step 1: Write the failing tests**

`src/panel/SetupView.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, test, vi } from 'vitest'
import type { Credentials } from '../shared/credentials'
import { SetupView, type SetupApi } from './SetupView'

function api(overrides: Partial<SetupApi> = {}): SetupApi {
  return {
    probe: async () => ({ passwordAuthEnabled: true, realmName: 'Acme' }),
    fetchApiKey: async () => 'fetched-key',
    validate: async () => {},
    ...overrides,
  }
}

async function toAuthStep(realm = 'acme.zulipchat.com') {
  fireEvent.input(screen.getByPlaceholderText('https://your-org.zulipchat.com'), { target: { value: realm } })
  fireEvent.submit(screen.getByPlaceholderText('https://your-org.zulipchat.com').closest('form')!)
  await waitFor(() => expect(screen.getByText('Sign in')).toBeTruthy())
}

describe('SetupView', () => {
  test('happy path via password tab completes with fetched key and normalized realm', async () => {
    const onComplete = vi.fn()
    render(<SetupView onComplete={onComplete} api={api()} />)
    await toAuthStep()
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), { target: { value: 'me@x.com' } })
    fireEvent.input(screen.getByPlaceholderText('Password'), { target: { value: 'hunter2' } })
    fireEvent.submit(screen.getByPlaceholderText('Password').closest('form')!)
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    const creds: Credentials = onComplete.mock.calls[0][0]
    expect(creds).toEqual({
      realmUrl: 'https://acme.zulipchat.com',
      email: 'me@x.com',
      apiKey: 'fetched-key',
      channelName: 'web-threads',
    })
  })

  test('happy path via API-key tab', async () => {
    const onComplete = vi.fn()
    render(<SetupView onComplete={onComplete} api={api()} />)
    await toAuthStep()
    fireEvent.click(screen.getByText('API key'))
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), { target: { value: 'me@x.com' } })
    fireEvent.input(screen.getByPlaceholderText('API key'), { target: { value: ' pasted-key ' } })
    fireEvent.submit(screen.getByPlaceholderText('API key').closest('form')!)
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    expect(onComplete.mock.calls[0][0].apiKey).toBe('pasted-key')
  })

  test('invalid realm input shows validation error without calling probe', async () => {
    const probe = vi.fn()
    render(<SetupView onComplete={() => {}} api={api({ probe })} />)
    fireEvent.input(screen.getByPlaceholderText('https://your-org.zulipchat.com'), { target: { value: 'http://not-local.example' } })
    fireEvent.submit(screen.getByPlaceholderText('https://your-org.zulipchat.com').closest('form')!)
    await waitFor(() => expect(screen.getByText(/valid realm URL/)).toBeTruthy())
    expect(probe).not.toHaveBeenCalled()
  })

  test('probe failure surfaces the error on the realm step', async () => {
    render(
      <SetupView onComplete={() => {}} api={api({ probe: async () => Promise.reject(new Error('unreachable')) })} />
    )
    fireEvent.input(screen.getByPlaceholderText('https://your-org.zulipchat.com'), { target: { value: 'acme.zulipchat.com' } })
    fireEvent.submit(screen.getByPlaceholderText('https://your-org.zulipchat.com').closest('form')!)
    await waitFor(() => expect(screen.getByText(/unreachable/)).toBeTruthy())
  })

  test('validate failure (e.g. channel missing) keeps auth step with message; password field cleared after failed submit too', async () => {
    render(
      <SetupView
        onComplete={() => {}}
        api={api({ validate: async () => Promise.reject(new Error("Channel #web-threads doesn't exist")) })}
      />
    )
    await toAuthStep()
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), { target: { value: 'me@x.com' } })
    fireEvent.input(screen.getByPlaceholderText('Password'), { target: { value: 'hunter2' } })
    fireEvent.submit(screen.getByPlaceholderText('Password').closest('form')!)
    await waitFor(() => expect(screen.getByText(/doesn't exist/)).toBeTruthy())
  })

  test('hides the Sign in tab when the realm has no password auth', async () => {
    render(
      <SetupView onComplete={() => {}} api={api({ probe: async () => ({ passwordAuthEnabled: false, realmName: 'A' }) })} />
    )
    await toAuthStep()
    expect(screen.queryByText('Sign in', { selector: 'button.tab' })).toBeNull()
    expect(screen.getByPlaceholderText('API key')).toBeTruthy()
  })
})
```

Note on `toAuthStep`: when the password tab is absent, the helper's waitFor target ('Sign in') won't exist — in that last test wait for the API-key field instead:

```tsx
  fireEvent.submit(...)
  await waitFor(() => expect(screen.getByPlaceholderText('API key')).toBeTruthy())
```

(Adjust the final test accordingly rather than reusing the helper.)

`src/panel/AccountView.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, test, vi } from 'vitest'
import { AccountView } from './AccountView'

const CREDS = { realmUrl: 'https://a.com', email: 'me@x.com', apiKey: 'k', channelName: 'web-threads' }

describe('AccountView', () => {
  test('shows realm, identity, and channel', () => {
    render(<AccountView credentials={CREDS} fullName="Me Myself" onClose={() => {}} onSignOut={() => {}} />)
    expect(screen.getByText('https://a.com')).toBeTruthy()
    expect(screen.getByText(/Me Myself/)).toBeTruthy()
    expect(screen.getByText(/me@x\.com/)).toBeTruthy()
    expect(screen.getByText('#web-threads')).toBeTruthy()
  })

  test('sign out and close fire callbacks', () => {
    const onSignOut = vi.fn()
    const onClose = vi.fn()
    render(<AccountView credentials={CREDS} onClose={onClose} onSignOut={onSignOut} />)
    fireEvent.click(screen.getByText('Sign out'))
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onSignOut).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/panel/SetupView.test.tsx src/panel/AccountView.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/panel/SetupView.tsx`:

```tsx
import { useReducer, useState } from 'preact/hooks'
import { normalizeRealmUrl, type Credentials } from '../shared/credentials'
import { ZulipClient } from '../shared/zulipClient'
import { INITIAL_SETUP, setupReducer, type ServerInfo } from './setupFlow'

export interface SetupApi {
  probe(realmUrl: string): Promise<ServerInfo>
  fetchApiKey(realmUrl: string, email: string, password: string): Promise<string>
  /** Throws Error with a user-facing message when credentials or channel are bad. */
  validate(creds: Credentials): Promise<void>
}

export const defaultSetupApi: SetupApi = {
  probe: async (realmUrl) => {
    const s = await ZulipClient.probeServer(realmUrl)
    return { passwordAuthEnabled: s.passwordAuthEnabled, realmName: s.realmName }
  },
  fetchApiKey: (realmUrl, email, password) => ZulipClient.fetchApiKey(realmUrl, email, password),
  validate: async (creds) => {
    const client = new ZulipClient(creds)
    try {
      await client.getOwnUser()
    } catch {
      throw new Error('Zulip rejected these credentials. Check the email and API key.')
    }
    try {
      await client.getStreamId(creds.channelName)
    } catch {
      throw new Error(
        `Channel #${creds.channelName} doesn't exist on this realm. Ask your Zulip admin to create it, then try again.`
      )
    }
  },
}

export function SetupView({ onComplete, api = defaultSetupApi }: { onComplete: (c: Credentials) => void; api?: SetupApi }) {
  const [state, dispatch] = useReducer(setupReducer, INITIAL_SETUP)
  const [realmInput, setRealmInput] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [channelName, setChannelName] = useState('web-threads')

  async function submitRealm(e: Event) {
    e.preventDefault()
    const normalized = normalizeRealmUrl(realmInput)
    if (!normalized) {
      dispatch({ type: 'probeFailed', message: 'Enter a valid realm URL (https://your-org.zulipchat.com).' })
      return
    }
    dispatch({ type: 'probeStarted' })
    try {
      const serverInfo = await api.probe(normalized)
      dispatch({ type: 'probeOk', realmUrl: normalized, serverInfo })
    } catch (err) {
      const hint =
        normalized.startsWith('https://') && err instanceof TypeError
          ? ' If this realm uses a self-signed certificate, open it in a tab and accept the warning first.'
          : ''
      dispatch({ type: 'probeFailed', message: errText(err) + hint })
    }
  }

  async function submitAuth(e: Event) {
    e.preventDefault()
    dispatch({ type: 'authStarted' })
    try {
      const key =
        state.authTab === 'password' ? await api.fetchApiKey(state.realmUrl, email.trim(), password) : apiKey.trim()
      const creds: Credentials = {
        realmUrl: state.realmUrl,
        email: email.trim(),
        apiKey: key,
        channelName: channelName.trim() || 'web-threads',
      }
      await api.validate(creds)
      setPassword('') // never keep the password around
      onComplete(creds)
    } catch (err) {
      dispatch({ type: 'authFailed', message: errText(err) })
    }
  }

  if (state.step === 'realm') {
    return (
      <form class="setup" onSubmit={(e) => void submitRealm(e)}>
        <h2>Connect to Zulip</h2>
        <p>PageThreads stores page discussions in a Zulip realm.</p>
        <label>
          Realm URL
          <input
            type="text"
            placeholder="https://your-org.zulipchat.com"
            value={realmInput}
            onInput={(e) => setRealmInput((e.target as HTMLInputElement).value)}
            disabled={state.busy}
          />
        </label>
        {state.error && <div class="error">{state.error}</div>}
        <button type="submit" disabled={state.busy}>
          {state.busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
    )
  }

  return (
    <form class="setup" onSubmit={(e) => void submitAuth(e)}>
      <h2>{state.serverInfo?.realmName || state.realmUrl}</h2>
      <p>
        {state.realmUrl}{' '}
        <button type="button" class="linkish" onClick={() => dispatch({ type: 'back' })}>
          Change
        </button>
      </p>
      <div class="tabs">
        {state.serverInfo?.passwordAuthEnabled && (
          <button
            type="button"
            class={state.authTab === 'password' ? 'tab active' : 'tab'}
            onClick={() => dispatch({ type: 'tabChanged', tab: 'password' })}
          >
            Sign in
          </button>
        )}
        <button
          type="button"
          class={state.authTab === 'apikey' ? 'tab active' : 'tab'}
          onClick={() => dispatch({ type: 'tabChanged', tab: 'apikey' })}
        >
          API key
        </button>
      </div>
      <label>
        Email
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          disabled={state.busy}
        />
      </label>
      {state.authTab === 'password' ? (
        <label>
          Password
          <input
            type="password"
            placeholder="Password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            disabled={state.busy}
          />
        </label>
      ) : (
        <label>
          API key <small>(Zulip → Personal settings → Account &amp; privacy)</small>
          <input
            type="password"
            placeholder="API key"
            value={apiKey}
            onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
            disabled={state.busy}
          />
        </label>
      )}
      <label>
        Channel
        <input
          type="text"
          value={channelName}
          onInput={(e) => setChannelName((e.target as HTMLInputElement).value)}
          disabled={state.busy}
        />
      </label>
      {state.error && <div class="error">{state.error}</div>}
      <button type="submit" disabled={state.busy}>
        {state.busy ? 'Connecting…' : state.authTab === 'password' ? 'Sign in' : 'Save'}
      </button>
    </form>
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
```

`src/panel/AccountView.tsx`:

```tsx
import type { Credentials } from '../shared/credentials'

export function AccountView({
  credentials,
  fullName,
  onClose,
  onSignOut,
}: {
  credentials: Credentials
  fullName?: string
  onClose: () => void
  onSignOut: () => void
}) {
  return (
    <div class="account">
      <header>
        <span class="title">Account</span>
        <button aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      <dl>
        <dt>Realm</dt>
        <dd>{credentials.realmUrl}</dd>
        <dt>Signed in as</dt>
        <dd>{fullName ? `${fullName} (${credentials.email})` : credentials.email}</dd>
        <dt>Channel</dt>
        <dd>#{credentials.channelName}</dd>
      </dl>
      <button class="danger" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  )
}
```

Append to `src/panel/style.css`:

```css
.setup { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
.setup h2 { margin: 0; }
.setup p { margin: 0; color: #555; }
.setup label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; font-size: 13px; }
.setup input { padding: 6px; font-size: 14px; }
.setup small { font-weight: 400; color: #777; }
.tabs { display: flex; gap: 4px; }
.tab { padding: 4px 10px; border: 1px solid #ccc; background: #f5f5f5; cursor: pointer; }
.tab.active { background: #fff; border-bottom-color: #fff; font-weight: 600; }
.linkish { border: none; background: none; color: #1a73e8; cursor: pointer; padding: 0; }
.account { display: flex; flex-direction: column; gap: 12px; padding: 0 0 16px; }
.account dl { margin: 0; padding: 0 16px; }
.account dt { font-weight: 600; font-size: 12px; color: #777; margin-top: 8px; }
.account dd { margin: 0; }
.account .danger { margin: 0 16px; color: #b3261e; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/panel/SetupView.test.tsx src/panel/AccountView.test.tsx`
Expected: PASS (8 tests). Then `npx tsc --noEmit` clean and `npm test` fully green.

- [ ] **Step 5: Commit**

```bash
git add src/panel/SetupView.tsx src/panel/SetupView.test.tsx src/panel/AccountView.tsx src/panel/AccountView.test.tsx src/panel/style.css
git commit -m "feat: onboarding and account views"
```

---

### Task 6: App gates on credentials

**Files:**
- Modify: `src/panel/App.tsx` (replace entire file)
- Modify: `src/shared/messages.ts` (add RuntimeToSw)

**Interfaces:**
- Consumes: everything above.
- Produces: `RuntimeToSw = ContentToSw | { type: 'credentialsChanged' }` (consumed by Task 7).

- [ ] **Step 1: Add the runtime message type**

In `src/shared/messages.ts`, add after `ContentToSw`:

```ts
/** Anything arriving at the service worker via chrome.runtime.sendMessage. */
export type RuntimeToSw = ContentToSw | { type: 'credentialsChanged' }
```

- [ ] **Step 2: Replace `src/panel/App.tsx`**

```tsx
import { useEffect, useReducer, useRef, useState } from 'preact/hooks'
import { createCredentialsStore, type Credentials } from '../shared/credentials'
import type { PageEntity, PanelToSw, RuntimeToSw, SwToPanel } from '../shared/messages'
import { createSettingsStore, DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { matchTopicByKey, topicKey, topicName } from '../shared/topic'
import { ZulipClient } from '../shared/zulipClient'
import { AccountView } from './AccountView'
import { Composer } from './Composer'
import { Drafts } from './drafts'
import { topicMatchesKey } from './eventMatch'
import { panelTarget, type PanelTargetState } from './panelTarget'
import { SetupView } from './SetupView'
import { ThreadView } from './ThreadView'
import { threadReducer } from './threadState'

const drafts = new Drafts()
const settingsStore = createSettingsStore()
const credentialsStore = createCredentialsStore()

interface Thread {
  entity: PageEntity
  key: string
  /** Exact topic name on the server, or null when no discussion exists yet. */
  existingTopic: string | null
}

function headerMessage(entity: PageEntity, email: string): string {
  const representativeUrl = entity.entityUri.replace(/^web:/, '')
  return [
    `🔗 Discussion for: ${entity.title}`,
    `Entity: \`${entity.entityUri}\` (resolver web@1)`,
    `Link: ${representativeUrl}`,
    `Started by ${email}`,
  ].join('\n')
}

function notifySwCredentialsChanged(): void {
  const msg: RuntimeToSw = { type: 'credentialsChanged' }
  void chrome.runtime.sendMessage(msg).catch(() => {})
}

export function App() {
  // undefined = still loading from storage; null = not configured (show setup)
  const [credentials, setCredentials] = useState<Credentials | null | undefined>(undefined)
  const [fullName, setFullName] = useState<string | undefined>(undefined)
  const [showAccount, setShowAccount] = useState(false)
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, dispatch] = useReducer(threadReducer, [])
  const [error, setError] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [draftText, setDraftText] = useState('')

  const threadRef = useRef<Thread | null>(null)
  threadRef.current = thread
  const targetRef = useRef<PanelTargetState>({ pinned: false, currentUri: null })
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const clientRef = useRef<ZulipClient | null>(null)
  const credsRef = useRef<Credentials | null>(null)

  function applyCredentials(c: Credentials | null) {
    credsRef.current = c
    clientRef.current = c ? new ZulipClient(c) : null
    setCredentials(c)
  }

  useEffect(() => {
    void credentialsStore.load().then(applyCredentials)
  }, [])

  useEffect(() => {
    void settingsStore.load().then((s) => (settingsRef.current = s))
    return settingsStore.watch((s) => (settingsRef.current = s))
  }, [])

  async function completeSetup(c: Credentials) {
    await credentialsStore.save(c)
    applyCredentials(c)
    notifySwCredentialsChanged()
  }

  async function signOut() {
    await credentialsStore.clear()
    targetRef.current = { pinned: false, currentUri: null }
    setThread(null)
    dispatch({ type: 'history', messages: [] })
    setDraftText('')
    setPinned(false)
    setError(null)
    setShowAccount(false)
    setFullName(undefined)
    applyCredentials(null)
    notifySwCredentialsChanged()
  }

  function requestActiveEntity() {
    portRef.current?.postMessage({ type: 'getActiveEntity' } satisfies PanelToSw)
  }

  function onDraftInput(text: string) {
    setDraftText(text)
    const uri = threadRef.current?.entity.entityUri
    if (uri) drafts.set(uri, text)
  }

  function applyPush(entity: PageEntity | null) {
    const { state, action } = panelTarget(
      targetRef.current,
      { type: 'push', entity },
      settingsRef.current.onNonWebPage
    )
    targetRef.current = state
    if (action === 'switch' && entity) {
      setError(null)
      setThread(null)
      dispatch({ type: 'history', messages: [] })
      setDraftText(drafts.get(entity.entityUri))
      initThread(entity).catch((e) => {
        setError(errText(e))
        targetRef.current = panelTarget(
          targetRef.current,
          { type: 'initFailed', uri: entity.entityUri },
          settingsRef.current.onNonWebPage
        ).state
      })
    } else if (action === 'clear') {
      setThread(null)
      dispatch({ type: 'history', messages: [] })
      setDraftText('')
    }
  }

  useEffect(() => {
    if (!credentials) return
    let disposed = false
    let port: chrome.runtime.Port
    let pingTimer: number | undefined

    const handleMessage = (msg: SwToPanel) => {
      if (msg.type === 'activeEntity') {
        applyPush(msg.entity)
      } else if (msg.type === 'newMessage') {
        const t = threadRef.current
        if (t && topicMatchesKey(msg.topic, t.key)) {
          if (!t.existingTopic) setThread({ ...t, existingTopic: msg.topic })
          dispatch({ type: 'append', message: msg.message })
        }
      } else if (msg.type === 'reconnected') {
        const t = threadRef.current
        if (t?.existingTopic) loadHistory(t.existingTopic, t.entity.entityUri).catch(() => {})
      }
    }

    function connect(isReconnect: boolean) {
      port = chrome.runtime.connect({ name: 'panel' })
      portRef.current = port
      port.onMessage.addListener(handleMessage)
      // Port messages are what reset the MV3 service-worker idle timer; the
      // long-poll fetch alone does not keep it alive. 20s < the 30s idle limit.
      pingTimer = window.setInterval(() => {
        try {
          port.postMessage({ type: 'ping' } satisfies PanelToSw)
        } catch {
          // Port already dead; onDisconnect is about to fire.
        }
      }, 20_000)
      port.onDisconnect.addListener(() => {
        window.clearInterval(pingTimer)
        if (disposed) return
        // SW was torn down; reconnecting wakes it and restarts the event loop.
        window.setTimeout(() => {
          if (!disposed) connect(true)
        }, 200)
      })
      const t = threadRef.current
      if (!isReconnect || !t) {
        port.postMessage({ type: 'getActiveEntity' } satisfies PanelToSw)
      } else if (t.existingTopic) {
        // Already resolved: skip re-init (SW tab map may be empty after restart),
        // just catch up on anything missed while the port was down.
        loadHistory(t.existingTopic, t.entity.entityUri).catch(() => {})
      }
    }

    connect(false)
    return () => {
      disposed = true
      window.clearInterval(pingTimer)
      portRef.current = null
      port.disconnect()
    }
  }, [credentials])

  async function initThread(entity: PageEntity) {
    const client = clientRef.current
    const creds = credsRef.current
    if (!client || !creds) return
    const key = await topicKey(entity.entityUri)
    const streamId = await client.getStreamId(creds.channelName)
    const topics = await client.getTopics(streamId)
    const existingTopic = matchTopicByKey(topics, key)
    // A later push may have switched targets while we awaited; don't clobber it.
    if (targetRef.current.currentUri !== entity.entityUri) return
    setThread({ entity, key, existingTopic })
    if (existingTopic) await loadHistory(existingTopic, entity.entityUri)
  }

  async function loadHistory(topic: string, forUri: string) {
    const client = clientRef.current
    const creds = credsRef.current
    if (!client || !creds) return
    const messages = await client.getMessages(creds.channelName, topic)
    // The user may have switched targets while the fetch was in flight.
    if (targetRef.current.currentUri !== forUri) return
    dispatch({ type: 'history', messages })
  }

  async function send(text: string) {
    const t = threadRef.current
    const client = clientRef.current
    const creds = credsRef.current
    if (!t || !client || !creds) return
    setError(null)
    try {
      let topic = t.existingTopic
      if (!topic) {
        topic = topicName(t.entity.title, t.key)
        // Header first (spec §6.2); on failure retry once, then proceed regardless —
        // the topicKey suffix still makes the thread resolvable.
        try {
          await client.sendMessage(creds.channelName, topic, headerMessage(t.entity, creds.email))
        } catch {
          await client.sendMessage(creds.channelName, topic, headerMessage(t.entity, creds.email)).catch(() => {})
        }
        setThread({ ...t, existingTopic: topic })
      }
      await client.sendMessage(creds.channelName, topic, text)
      drafts.clear(t.entity.entityUri)
      if (targetRef.current.currentUri === t.entity.entityUri) setDraftText('')
      await loadHistory(topic, t.entity.entityUri)
    } catch (e) {
      setError(errText(e))
    }
  }

  function togglePin() {
    const event = targetRef.current.pinned ? ({ type: 'unpin' } as const) : ({ type: 'pin' } as const)
    const { state, action } = panelTarget(targetRef.current, event, settingsRef.current.onNonWebPage)
    targetRef.current = state
    setPinned(state.pinned)
    if (action === 'refresh') requestActiveEntity()
  }

  function openAccount() {
    setShowAccount(true)
    if (!fullName && clientRef.current) {
      clientRef.current
        .getOwnUser()
        .then((u) => setFullName(u.fullName))
        .catch(() => {})
    }
  }

  if (credentials === undefined) {
    return <div class="empty">Loading…</div>
  }
  if (credentials === null) {
    return <SetupView onComplete={(c) => void completeSetup(c)} />
  }
  if (showAccount) {
    return (
      <AccountView
        credentials={credentials}
        fullName={fullName}
        onClose={() => setShowAccount(false)}
        onSignOut={() => void signOut()}
      />
    )
  }

  return (
    <div class="app">
      <header title={thread?.entity.entityUri}>
        <span class="title">{thread ? thread.entity.title : 'PageThreads'}</span>
        <button
          class={pinned ? 'pin pinned' : 'pin'}
          title={pinned ? 'Unpin: follow the active tab' : 'Pin: keep this thread while browsing'}
          onClick={togglePin}
        >
          📌
        </button>
        <button class="pin" title="Account" onClick={openAccount}>
          ⚙️
        </button>
      </header>
      {error && (
        <div class="error" role="alert">
          <span onClick={() => setError(null)}>
            {error} <small>(click to dismiss)</small>
          </span>
          {!thread && (
            <button class="retry" onClick={requestActiveEntity}>
              Retry
            </button>
          )}
        </div>
      )}
      <ThreadView messages={messages} hasThread={!!thread?.existingTopic} noPage={!thread && !error} />
      <Composer value={draftText} onInput={onDraftInput} onSend={(text) => void send(text)} disabled={!thread} />
    </div>
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: tsc clean; all suites pass; build green. (`src/config.ts` still exists and is now unused by the panel — removed in Task 8 after the SW stops using it too.)

- [ ] **Step 4: Commit**

```bash
git add src/panel/App.tsx src/shared/messages.ts
git commit -m "feat: panel gates on stored credentials with setup and account views"
```

---

### Task 7: Service worker reads credentials from storage

**Files:**
- Modify: `src/background/index.ts`

**Interfaces:**
- Consumes: `createCredentialsStore` (Task 2), `RuntimeToSw` (Task 6).
- Produces: SW behavior — loop starts only when credentials exist AND ≥1 port is connected; `credentialsChanged` message and `credentialsStore.watch` both restart/stop the loop.

- [ ] **Step 1: Implement**

In `src/background/index.ts`:

1. Replace the `config` import and client/loop setup. Remove:

```ts
import { config } from '../config'
...
const client = new ZulipClient(config)
let loop: EventLoop | null = null
```

Add (imports at top; `ContentToSw` in the onMessage listener becomes `RuntimeToSw`):

```ts
import { createCredentialsStore, type Credentials } from '../shared/credentials'
import type { PageEntity, PanelToSw, RuntimeToSw, SwToContent, SwToPanel } from '../shared/messages'
```

and after `const ports = new Set<chrome.runtime.Port>()`:

```ts
const credentialsStore = createCredentialsStore()
let credentials: Credentials | null = null
let loop: EventLoop | null = null

void credentialsStore.load().then((c) => {
  credentials = c
  startLoopIfReady()
})

// Belt-and-braces alongside the credentialsChanged message: a missed message
// cannot leave a loop running against stale credentials.
credentialsStore.watch((c) => {
  credentials = c
  restartLoop()
})

function startLoopIfReady(): void {
  if (loop || !credentials || ports.size === 0) return
  const client = new ZulipClient(credentials)
  loop = new EventLoop(client, credentials.channelName, {
    onEvent: (event) => {
      if (event.type === 'message' && event.message) {
        broadcast({ type: 'newMessage', topic: event.message.subject, message: event.message })
      }
    },
    onReconnect: () => broadcast({ type: 'reconnected' }),
  })
  void loop.start()
}

function restartLoop(): void {
  loop?.stop()
  loop = null
  startLoopIfReady()
}
```

2. The `chrome.runtime.onMessage` listener handles the new message type:

```ts
chrome.runtime.onMessage.addListener((msg: RuntimeToSw, sender) => {
  if (msg.type === 'pageEntity' && sender.tab?.id != null) {
    tabEntities.set(sender.tab.id, { entityUri: msg.entityUri, title: msg.title })
    if (sender.tab.active) void pushActiveEntity()
  } else if (msg.type === 'credentialsChanged') {
    void credentialsStore.load().then((c) => {
      credentials = c
      restartLoop()
    })
  }
})
```

3. In the `onConnect` listener, replace the whole `if (!loop) { loop = new EventLoop(...); void loop.start() }` block with:

```ts
  startLoopIfReady()
```

4. The `onDisconnect` teardown keeps its shape but goes through the helper:

```ts
  port.onDisconnect.addListener(() => {
    ports.delete(port)
    if (ports.size === 0) {
      loop?.stop()
      loop = null
    }
  })
```

(unchanged from today — included for orientation only). Everything else (tabEntities, entityForTab, pushActiveEntity, broadcast, getActiveEntity reply) stays as-is.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all green. Confirm with `grep -rn "from '../config'" src/` → only hits (if any) must be gone from `src/background/` and `src/panel/`; expected result: no matches anywhere.

- [ ] **Step 3: Commit**

```bash
git add src/background/index.ts
git commit -m "feat: service worker builds event loop from stored credentials"
```

---

### Task 8: Remove config files; docs; version 0.2.0

**Files:**
- Delete: `src/config.example.ts` (tracked), `src/config.ts` (untracked local file), `dist-user2/` (untracked)
- Modify: `.gitignore`, `README.md`, `dev/zulip/README.md`, `dev/run-chrome.sh`, `package.json`, `public/manifest.json`

- [ ] **Step 1: Delete config machinery**

```bash
git rm src/config.example.ts
rm -f src/config.ts
rm -rf dist-user2
```

In `.gitignore`, delete the two lines `src/config.ts` and `/dist-user2/`.

Run: `npm run build && npm test && npx tsc --noEmit` — must all pass with the files gone (proves nothing imports config anymore).

- [ ] **Step 2: Docs and version**

1. `package.json` and `public/manifest.json`: `"version": "0.2.0"`.
2. `README.md` Build section: remove the `cp src/config.example.ts …` line entirely; after the "Load in Chrome" section add:

```markdown
## First run

Open the panel on any page: PageThreads asks for your Zulip realm URL, then
lets you sign in with email+password (realms with password auth) or paste an
API key (Zulip → Personal settings → Account & privacy → API key). The
channel (default `web-threads`) must already exist on the realm. Credentials
are stored in extension storage; use the ⚙️ menu to sign out.
```

3. `README.md`: add after the M1a checklist:

```markdown
## M1b acceptance checklist

- [ ] Fresh profile: onboard via email+password against the dev realm; reach a working thread view.
- [ ] Fresh profile: onboard via API-key paste.
- [ ] Wrong password shows Zulip's error; wrong API key shows the credentials error.
- [ ] Unreachable realm URL errors on the realm step; a self-signed-cert realm shows the accept-the-warning hint.
- [ ] Channel name that doesn't exist shows the "ask your admin" error; works after creating the channel.
- [ ] ⚙️ → Sign out returns to setup; signing in as a different user gets live updates for that account (post from the Zulip web UI to verify).
- [ ] Credentials survive a full browser restart.
- [ ] Second profile (`dev/run-chrome.sh user2`) onboards as the second user with the SAME dist/ build — dist-user2 is gone.
```

4. `dev/zulip/README.md`: replace the "Second test user" section's build instructions with:

```markdown
Use them from a second Chrome profile with the same build: `dev/run-chrome.sh
user2` and sign in as the second user through the panel's own onboarding —
separate builds per user are no longer needed.
```

(keep the surrounding notes about creating the user / no outgoing email).

5. `dev/run-chrome.sh`: update the usage comment block to:

```bash
# Launch Chrome for Testing with the PageThreads extension pre-loaded.
# Usage: dev/run-chrome.sh [profile-name] [extension-dir]
#   dev/run-chrome.sh          -> profile user1, extension dist/
#   dev/run-chrome.sh user2    -> second profile, same dist/ (sign in as another user)
```

- [ ] **Step 3: Verify and commit**

Run: `npm run build && npm test && npx tsc --noEmit` — all green.

```bash
git add -A
git commit -m "chore: retire config.ts; onboarding docs; version 0.2.0"
```

---

## Plan self-review notes

- **Spec coverage:** storage layer + race fix (T1), credentials + normalizeRealmUrl (T2), probe/fetch_api_key/getOwnUser (T3), setup reducer (T4), SetupView/AccountView incl. cert hint + channel-missing copy + password hygiene (T5), App gating + credentialsChanged + sign-out reset (T6), SW storage-driven loop + watch (T7), config removal + docs + dist-user2 retirement + 0.2.0 (T8). Spec's `requiresPassword` field implemented as `passwordAuthEnabled` (noted in T3).
- **Type consistency:** `Credentials` (T2) used in T5/T6/T7; `SetupApi`/`ServerInfo` (T4/T5) aligned; `RuntimeToSw` (T6) consumed in T7; `loadHistory(topic, forUri)` signature preserved from M1a.
- **Sequencing:** panel stops importing config in T6 but the file itself survives until T8 (SW still imports it through T6; removed in T7; deletion verified by build in T8 Step 1).

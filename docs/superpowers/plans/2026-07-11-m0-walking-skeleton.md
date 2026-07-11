# PageThreads M0 Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loadable Chrome MV3 extension that attaches a live Zulip-backed discussion thread to any web page: open side panel → resolve page to topic → read history → post → see others' messages live.

**Architecture:** Three build entries (content script, service worker, Preact side panel) from one repo. Content script canonicalizes the page URL and reports it to the service worker. The service worker keeps a `tabId → entity` map and owns the Zulip event long-poll, fanning message events to panel ports. The panel calls Zulip REST directly (topics/history/send) using a hardcoded realm + API key from gitignored `src/config.ts`.

**Tech Stack:** TypeScript (strict), Vite (two configs: ES-module panel+background build, IIFE content-script build), Preact, Vitest (+ @testing-library/preact + happy-dom for component tests), tldts (registrable-domain check), local Zulip via docker-zulip.

**Spec:** `docs/superpowers/specs/2026-07-11-m0-walking-skeleton-design.md` (and parent `WHAT.md`).

## Global Constraints

- Chrome only; Manifest V3; manifest permissions exactly `["sidePanel"]`, host_permissions `["<all_urls>"]`.
- `src/shared/*` must stay browser-extension-API-free (pure or fetch-only) so Vitest runs them in Node without chrome mocks.
- Content script does **no DOM writes** to the host page.
- Panel bundle < 200 KB (Preact keeps this trivial at M0; don't add UI deps).
- `src/config.ts` is gitignored; `src/config.example.ts` is the checked-in template. Never commit `src/config.ts`.
- `topicKey = base64url(sha256(entityUri))[:16]`; topic name = `"<title ≤40 chars> · <topicKey>"`; threads resolve by `· <topicKey>` suffix, never by title.
- Message rendering is escaped plain text + linkified URLs. No Markdown/HTML rendering in M0.
- Node 20+ assumed (global `fetch`, `crypto.subtle`, `btoa`, `Response`).
- Commit after every task; commit messages end with the Co-Authored-By / Claude-Session trailers used in this repo.

---

### Task 1: Project scaffolding and build pipeline

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vite.content.config.ts`, `vitest.config.ts`, `.gitignore`, `public/manifest.json`, `src/config.example.ts`, `src/config.ts` (local copy, not committed), `src/content/index.ts` (placeholder), `src/background/index.ts` (placeholder), `src/panel/index.html`, `src/panel/main.tsx` (placeholder), `src/panel/style.css`

**Interfaces:**
- Produces: a working `npm run build` (outputs `dist/` loadable as unpacked extension) and `npm test`. Later tasks assume these exist and that `src/config.ts` exports `config: { realmUrl, email, apiKey, channelName }`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "page-threads",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit && vite build && vite build -c vite.content.config.ts",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest"
  },
  "dependencies": {
    "preact": "^10.22.0",
    "tldts": "^6.1.0"
  },
  "devDependencies": {
    "@preact/preset-vite": "^2.8.0",
    "@testing-library/preact": "^3.2.4",
    "@types/chrome": "^0.0.268",
    "happy-dom": "^15.0.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "strict": true,
    "noEmit": true,
    "types": ["chrome"],
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create the two Vite configs and vitest config**

`vite.config.ts` (panel HTML entry + module service worker):

```ts
import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        panel: 'src/panel/index.html',
        background: 'src/background/index.ts',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
})
```

`vite.content.config.ts` (self-contained classic script — content scripts cannot be ES modules):

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content/index.ts',
      name: 'PageThreadsContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
})
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  test: { environment: 'node' },
})
```

- [ ] **Step 4: Create .gitignore, manifest, config template**

`.gitignore`:

```
node_modules/
dist/
src/config.ts
```

`public/manifest.json` (Vite copies `public/` to `dist/` root):

```json
{
  "manifest_version": 3,
  "name": "PageThreads",
  "version": "0.0.1",
  "description": "Zulip-backed discussion threads for any web page (M0 walking skeleton)",
  "action": { "default_title": "PageThreads" },
  "side_panel": { "default_path": "src/panel/index.html" },
  "permissions": ["sidePanel"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_idle" }
  ]
}
```

`src/config.example.ts`:

```ts
// Copy to src/config.ts (gitignored) and fill in real values.
export const config = {
  realmUrl: 'http://localhost:9090',
  email: 'you@example.com',
  apiKey: 'PASTE_API_KEY_FROM_ZULIP_PERSONAL_SETTINGS',
  channelName: 'web-threads',
}
```

Then run: `cp src/config.example.ts src/config.ts`

- [ ] **Step 5: Create placeholder entry points**

`src/content/index.ts`:

```ts
console.debug('[PageThreads] content script loaded')
export {}
```

`src/background/index.ts`:

```ts
console.debug('[PageThreads] service worker loaded')
export {}
```

`src/panel/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>PageThreads</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/panel/main.tsx`:

```tsx
import { render } from 'preact'

render(<div>PageThreads</div>, document.getElementById('root')!)
```

`src/panel/style.css`:

```css
:root { font-family: system-ui, sans-serif; font-size: 14px; }
* { box-sizing: border-box; }
body { margin: 0; }
```

- [ ] **Step 6: Install and verify build + test runner**

Run: `npm install`
Run: `npm run build`
Expected: exit 0; `dist/` contains `manifest.json`, `background.js`, `content.js`, `src/panel/index.html`, and panel JS/CSS assets.

Run: `npm test`
Expected: exit 0 (`--passWithNoTests`).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vite.content.config.ts vitest.config.ts .gitignore public/manifest.json src/config.example.ts src/content/index.ts src/background/index.ts src/panel/
git commit -m "chore: scaffold MV3 extension build (Vite multi-entry, Preact, Vitest)"
```

---

### Task 2: URL canonicalizer (`shared/canonicalize.ts`)

**Files:**
- Create: `src/shared/canonicalize.ts`
- Test: `src/shared/canonicalize.test.ts`

**Interfaces:**
- Produces: `canonicalize(href: string, canonicalHref: string | null): string` — returns the canonical URL string `C`. Callers build `entityUri = 'web:' + C`.

- [ ] **Step 1: Write the failing tests**

`src/shared/canonicalize.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { canonicalize } from './canonicalize'

describe('canonical link handling (spec §4.4 step 1)', () => {
  test('uses same-domain absolute canonical link as-is', () => {
    expect(
      canonicalize('https://example.com/article?page=2', 'https://example.com/article')
    ).toBe('https://example.com/article')
  })

  test('accepts canonical on a different subdomain of the same registrable domain', () => {
    expect(
      canonicalize('https://m.example.com/article', 'https://www.example.com/article')
    ).toBe('https://www.example.com/article')
  })

  test('rejects cross-domain canonical (syndication) and normalizes instead', () => {
    expect(
      canonicalize('https://syndicator.com/story/', 'https://original-publisher.com/story')
    ).toBe('https://syndicator.com/story')
  })

  test('rejects relative canonical (spec requires absolute)', () => {
    expect(canonicalize('https://example.com/a/', '/a')).toBe('https://example.com/a')
  })

  test('rejects non-http canonical', () => {
    expect(canonicalize('https://example.com/a', 'ftp://example.com/a')).toBe(
      'https://example.com/a'
    )
  })
})

describe('normalization (spec §4.4 step 2)', () => {
  test('lowercases scheme and host', () => {
    expect(canonicalize('HTTPS://EXAMPLE.COM/Path', null)).toBe('https://example.com/Path')
  })

  test('strips default ports', () => {
    expect(canonicalize('https://example.com:443/a', null)).toBe('https://example.com/a')
    expect(canonicalize('http://example.com:80/a', null)).toBe('http://example.com/a')
  })

  test('keeps non-default ports', () => {
    expect(canonicalize('http://localhost:9090/a', null)).toBe('http://localhost:9090/a')
  })

  test('strips trailing slash except on root', () => {
    expect(canonicalize('https://example.com/a/b/', null)).toBe('https://example.com/a/b')
    expect(canonicalize('https://example.com/', null)).toBe('https://example.com/')
    expect(canonicalize('https://example.com', null)).toBe('https://example.com/')
  })

  test('strips fragment', () => {
    expect(canonicalize('https://example.com/a#section-3', null)).toBe('https://example.com/a')
  })

  test('removes tracking params: utm_* prefix, exact names, vero_* prefix', () => {
    expect(
      canonicalize(
        'https://example.com/a?utm_source=x&utm_campaign=y&gclid=1&fbclid=2&mc_cid=3&mc_eid=4&igshid=5&ref=6&ref_src=7&_hsenc=8&_hsmi=9&vero_conv=10&yclid=11&msclkid=12',
        null
      )
    ).toBe('https://example.com/a')
  })

  test('keeps and sorts remaining params lexicographically', () => {
    expect(canonicalize('https://example.com/a?zeta=1&alpha=2&utm_source=x', null)).toBe(
      'https://example.com/a?alpha=2&zeta=1'
    )
  })

  test('tracking-param matching is case-insensitive', () => {
    expect(canonicalize('https://example.com/a?UTM_Source=x&id=5', null)).toBe(
      'https://example.com/a?id=5'
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/canonicalize.test.ts`
Expected: FAIL — cannot resolve `./canonicalize`.

- [ ] **Step 3: Implement**

`src/shared/canonicalize.ts`:

```ts
import { getDomain } from 'tldts'

const TRACKING_EXACT = new Set([
  'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src',
  '_hsenc', '_hsmi', 'yclid', 'msclkid',
])
const TRACKING_PREFIXES = ['utm_', 'vero_']

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase()
  return TRACKING_EXACT.has(k) || TRACKING_PREFIXES.some((p) => k.startsWith(p))
}

function acceptableCanonical(canonicalHref: string, pageHref: string): string | null {
  if (!/^https?:\/\//i.test(canonicalHref)) return null // must be absolute http(s)
  try {
    const c = new URL(canonicalHref)
    const page = new URL(pageHref)
    const cDomain = getDomain(c.hostname)
    const pDomain = getDomain(page.hostname)
    if (cDomain === null || pDomain === null || cDomain !== pDomain) return null
    return c.href
  } catch {
    return null
  }
}

/** Spec §4.4 steps 1–2: canonical-link check, else URL normalization. */
export function canonicalize(href: string, canonicalHref: string | null): string {
  if (canonicalHref) {
    const accepted = acceptableCanonical(canonicalHref, href)
    if (accepted !== null) return accepted
  }

  const u = new URL(href) // lowercases scheme+host, strips default ports
  u.hash = ''
  if (u.pathname !== '/' && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '')
  }
  const kept = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k))
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const sp = new URLSearchParams()
  for (const [k, v] of kept) sp.append(k, v)
  const q = sp.toString()
  return u.origin + u.pathname + (q ? `?${q}` : '')
}
```

Note: `new URL('https://example.com').pathname` is `'/'`, so the bare-host test yields `https://example.com/` — root keeps its slash.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/canonicalize.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/canonicalize.ts src/shared/canonicalize.test.ts
git commit -m "feat: generic web URL canonicalizer (spec §4.4 steps 1-2)"
```

---

### Task 3: Topic key and name (`shared/topic.ts`)

**Files:**
- Create: `src/shared/topic.ts`
- Test: `src/shared/topic.test.ts`

**Interfaces:**
- Produces:
  - `topicKey(entityUri: string): Promise<string>` — 16-char base64url of sha256.
  - `topicName(title: string, key: string): string` — `"<title ≤40> · <key>"`.
  - `matchTopicByKey(topics: string[], key: string): string | null` — finds existing topic by `· <key>` suffix.

- [ ] **Step 1: Write the failing tests**

`src/shared/topic.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { matchTopicByKey, topicKey, topicName } from './topic'

describe('topicKey', () => {
  test('matches independent sha256/base64url computation', async () => {
    const uri = 'web:https://example.com/'
    const expected = createHash('sha256').update(uri).digest('base64url').slice(0, 16)
    expect(await topicKey(uri)).toBe(expected)
  })

  test('is 16 chars of base64url alphabet', async () => {
    const key = await topicKey('web:https://example.com/a?b=1')
    expect(key).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  test('different URIs give different keys', async () => {
    expect(await topicKey('web:https://a.com/')).not.toBe(await topicKey('web:https://b.com/'))
  })
})

describe('topicName', () => {
  test('joins title and key with " · "', () => {
    expect(topicName('My Page', 'k'.repeat(16))).toBe(`My Page · ${'k'.repeat(16)}`)
  })

  test('truncates title to 40 chars (total stays under Zulip 60-char limit)', () => {
    const name = topicName('x'.repeat(100), 'k'.repeat(16))
    expect(name).toBe(`${'x'.repeat(40)} · ${'k'.repeat(16)}`)
    expect(name.length).toBeLessThanOrEqual(60)
  })

  test('falls back to Untitled for empty title', () => {
    expect(topicName('   ', 'k'.repeat(16))).toBe(`Untitled · ${'k'.repeat(16)}`)
  })
})

describe('matchTopicByKey', () => {
  test('finds topic by suffix regardless of title part', () => {
    const topics = ['Other thing · aaaaaaaaaaaaaaaa', 'Renamed Title · bbbbbbbbbbbbbbbb']
    expect(matchTopicByKey(topics, 'bbbbbbbbbbbbbbbb')).toBe('Renamed Title · bbbbbbbbbbbbbbbb')
  })

  test('returns null when absent', () => {
    expect(matchTopicByKey(['A · aaaaaaaaaaaaaaaa'], 'cccccccccccccccc')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/topic.test.ts`
Expected: FAIL — cannot resolve `./topic`.

- [ ] **Step 3: Implement**

`src/shared/topic.ts`:

```ts
/** base64url(sha256(entityUri))[:16] — spec §4.6. Uses Web Crypto (panel/SW and Node 20+). */
export async function topicKey(entityUri: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entityUri))
  let bin = ''
  for (const byte of new Uint8Array(digest)) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16)
}

export function topicName(title: string, key: string): string {
  const t = title.trim().slice(0, 40).trim() || 'Untitled'
  return `${t} · ${key}`
}

export function matchTopicByKey(topics: string[], key: string): string | null {
  const suffix = `· ${key}`
  return topics.find((t) => t.endsWith(suffix)) ?? null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/topic.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/topic.ts src/shared/topic.test.ts
git commit -m "feat: topic key derivation and topic-name builder (spec §4.6)"
```

---

### Task 4: Zulip REST client (`shared/zulipClient.ts`)

**Files:**
- Create: `src/shared/zulipClient.ts`
- Test: `src/shared/zulipClient.test.ts`

**Interfaces:**
- Produces:

```ts
interface ZulipConfig { realmUrl: string; email: string; apiKey: string }
interface ZulipMessage { id: number; sender_full_name: string; sender_email: string; content: string; timestamp: number; subject: string }
interface ZulipEvent { id: number; type: string; message?: ZulipMessage }
class ZulipError extends Error { code?: string }
class ZulipClient {
  constructor(cfg: ZulipConfig, fetchFn?: typeof fetch)
  getStreamId(name: string): Promise<number>
  getTopics(streamId: number): Promise<string[]>
  getMessages(channel: string, topic: string): Promise<ZulipMessage[]>
  sendMessage(channel: string, topic: string, content: string): Promise<number>
  register(channel: string): Promise<{ queueId: string; lastEventId: number }>
  getEvents(queueId: string, lastEventId: number): Promise<ZulipEvent[]>
}
```

- [ ] **Step 1: Write the failing tests**

`src/shared/zulipClient.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { ZulipClient, ZulipError } from './zulipClient'

const cfg = { realmUrl: 'http://localhost:9090', email: 'me@x.com', apiKey: 'secret' }

function fakeFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fn = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(payload), { status })
  }) as typeof fetch
  return { fn, calls }
}

describe('auth and encoding', () => {
  test('sends HTTP basic auth header', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', stream_id: 7 })
    await new ZulipClient(cfg, fn).getStreamId('web-threads')
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + btoa('me@x.com:secret')
    )
  })

  test('GET params go in the query string, JSON-encoding non-strings', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', messages: [] })
    await new ZulipClient(cfg, fn).getMessages('web-threads', 'T · k')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/v1/messages')
    expect(url.searchParams.get('anchor')).toBe('newest')
    expect(url.searchParams.get('num_before')).toBe('50')
    expect(url.searchParams.get('apply_markdown')).toBe('false')
    expect(JSON.parse(url.searchParams.get('narrow')!)).toEqual([
      { operator: 'channel', operand: 'web-threads' },
      { operator: 'topic', operand: 'T · k' },
    ])
  })

  test('POST params go form-encoded in the body', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', id: 42 })
    const id = await new ZulipClient(cfg, fn).sendMessage('web-threads', 'T · k', 'hello')
    expect(id).toBe(42)
    expect(calls[0].init!.method).toBe('POST')
    const body = calls[0].init!.body as URLSearchParams
    expect(body.get('type')).toBe('stream')
    expect(body.get('to')).toBe('web-threads')
    expect(body.get('topic')).toBe('T · k')
    expect(body.get('content')).toBe('hello')
  })
})

describe('endpoints', () => {
  test('getStreamId', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', stream_id: 7 })
    expect(await new ZulipClient(cfg, fn).getStreamId('web-threads')).toBe(7)
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/v1/get_stream_id')
    expect(url.searchParams.get('stream')).toBe('web-threads')
  })

  test('getTopics returns names', async () => {
    const { fn, calls } = fakeFetch({
      result: 'success',
      topics: [{ name: 'A · k1', max_id: 5 }, { name: 'B · k2', max_id: 9 }],
    })
    expect(await new ZulipClient(cfg, fn).getTopics(7)).toEqual(['A · k1', 'B · k2'])
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/users/me/7/topics')
  })

  test('register maps queue fields and narrows to the channel', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', queue_id: 'q9', last_event_id: -1 })
    const q = await new ZulipClient(cfg, fn).register('web-threads')
    expect(q).toEqual({ queueId: 'q9', lastEventId: -1 })
    const body = calls[0].init!.body as URLSearchParams
    expect(JSON.parse(body.get('event_types')!)).toEqual(['message'])
    expect(JSON.parse(body.get('narrow')!)).toEqual([['channel', 'web-threads']])
  })

  test('getEvents returns events array', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', events: [{ id: 3, type: 'heartbeat' }] })
    const events = await new ZulipClient(cfg, fn).getEvents('q9', 2)
    expect(events).toEqual([{ id: 3, type: 'heartbeat' }])
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/v1/events')
    expect(url.searchParams.get('queue_id')).toBe('q9')
    expect(url.searchParams.get('last_event_id')).toBe('2')
  })
})

describe('errors', () => {
  test('Zulip error payload throws ZulipError with msg and code', async () => {
    const { fn } = fakeFetch(
      { result: 'error', msg: 'Bad event queue id', code: 'BAD_EVENT_QUEUE_ID' },
      400
    )
    const err = await new ZulipClient(cfg, fn).getEvents('q', 0).catch((e) => e)
    expect(err).toBeInstanceOf(ZulipError)
    expect(err.message).toBe('Bad event queue id')
    expect(err.code).toBe('BAD_EVENT_QUEUE_ID')
  })

  test('non-JSON error response throws with HTTP status', async () => {
    const fn = (async () => new Response('<html>gateway timeout</html>', { status: 502 })) as typeof fetch
    const err = await new ZulipClient(cfg, fn).getStreamId('x').catch((e) => e)
    expect(err).toBeInstanceOf(ZulipError)
    expect(err.message).toBe('HTTP 502')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/zulipClient.test.ts`
Expected: FAIL — cannot resolve `./zulipClient`.

- [ ] **Step 3: Implement**

`src/shared/zulipClient.ts`:

```ts
export interface ZulipConfig {
  realmUrl: string
  email: string
  apiKey: string
}

export interface ZulipMessage {
  id: number
  sender_full_name: string
  sender_email: string
  content: string
  timestamp: number
  subject: string // Zulip's field name for the topic
}

export interface ZulipEvent {
  id: number
  type: string
  message?: ZulipMessage
}

export class ZulipError extends Error {
  constructor(msg: string, readonly code?: string) {
    super(msg)
    this.name = 'ZulipError'
  }
}

export class ZulipClient {
  constructor(private cfg: ZulipConfig, private fetchFn: typeof fetch = fetch) {}

  private async request(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, unknown>
  ): Promise<any> {
    const url = new URL(`/api/v1${path}`, this.cfg.realmUrl)
    const init: RequestInit = {
      method,
      headers: { Authorization: 'Basic ' + btoa(`${this.cfg.email}:${this.cfg.apiKey}`) },
    }
    if (params) {
      const encoded = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        encoded.set(k, typeof v === 'string' ? v : JSON.stringify(v))
      }
      if (method === 'GET') url.search = encoded.toString()
      else init.body = encoded
    }
    const res = await this.fetchFn(url.toString(), init)
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.result !== 'success') {
      throw new ZulipError(data.msg ?? `HTTP ${res.status}`, data.code)
    }
    return data
  }

  async getStreamId(name: string): Promise<number> {
    return (await this.request('GET', '/get_stream_id', { stream: name })).stream_id
  }

  async getTopics(streamId: number): Promise<string[]> {
    const data = await this.request('GET', `/users/me/${streamId}/topics`)
    return data.topics.map((t: { name: string }) => t.name)
  }

  async getMessages(channel: string, topic: string): Promise<ZulipMessage[]> {
    const data = await this.request('GET', '/messages', {
      anchor: 'newest',
      num_before: 50,
      num_after: 0,
      apply_markdown: false,
      narrow: [
        { operator: 'channel', operand: channel },
        { operator: 'topic', operand: topic },
      ],
    })
    return data.messages
  }

  async sendMessage(channel: string, topic: string, content: string): Promise<number> {
    const data = await this.request('POST', '/messages', {
      type: 'stream',
      to: channel,
      topic,
      content,
    })
    return data.id
  }

  async register(channel: string): Promise<{ queueId: string; lastEventId: number }> {
    const data = await this.request('POST', '/register', {
      event_types: ['message'],
      narrow: [['channel', channel]],
    })
    return { queueId: data.queue_id, lastEventId: data.last_event_id }
  }

  async getEvents(queueId: string, lastEventId: number): Promise<ZulipEvent[]> {
    const data = await this.request('GET', '/events', {
      queue_id: queueId,
      last_event_id: lastEventId,
    })
    return data.events
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/zulipClient.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/zulipClient.ts src/shared/zulipClient.test.ts
git commit -m "feat: typed Zulip REST client with basic-auth fetch wrapper"
```

---

### Task 5: Runtime message types + content script

**Files:**
- Create: `src/shared/messages.ts`
- Modify: `src/content/index.ts` (replace placeholder)

**Interfaces:**
- Consumes: `canonicalize` from Task 2.
- Produces (used by Tasks 7 and 9):

```ts
interface PageEntity { entityUri: string; title: string }
type ContentToSw = { type: 'pageEntity' } & PageEntity          // via chrome.runtime.sendMessage
type PanelToSw = { type: 'getActiveEntity' }                     // via port 'panel'
type SwToPanel =
  | { type: 'activeEntity'; entity: PageEntity | null }
  | { type: 'newMessage'; topic: string; message: ZulipMessage }
  | { type: 'reconnected' }
```

- [ ] **Step 1: Create the shared protocol types**

`src/shared/messages.ts`:

```ts
import type { ZulipMessage } from './zulipClient'

export interface PageEntity {
  entityUri: string
  title: string
}

/** Content script → service worker, via chrome.runtime.sendMessage. */
export type ContentToSw = { type: 'pageEntity' } & PageEntity

/** Panel → service worker, via the 'panel' Port. */
export type PanelToSw = { type: 'getActiveEntity' }

/** Service worker → panel, via the 'panel' Port. */
export type SwToPanel =
  | { type: 'activeEntity'; entity: PageEntity | null }
  | { type: 'newMessage'; topic: string; message: ZulipMessage }
  | { type: 'reconnected' }
```

- [ ] **Step 2: Implement the content script**

`src/content/index.ts` (replace entire file). Thin glue — all logic lives in the tested `canonicalize`; no unit test, verified end-to-end in Task 10:

```ts
import { canonicalize } from '../shared/canonicalize'
import type { ContentToSw } from '../shared/messages'

const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
const entityUri = 'web:' + canonicalize(location.href, link?.getAttribute('href') ?? null)

const msg: ContentToSw = { type: 'pageEntity', entityUri, title: document.title }
void chrome.runtime.sendMessage(msg).catch(() => {
  // Service worker may not be listening yet (e.g. right after install); harmless.
})
```

- [ ] **Step 3: Verify build and existing tests**

Run: `npm run build && npm test`
Expected: both exit 0; `dist/content.js` now bundles the canonicalizer.

- [ ] **Step 4: Commit**

```bash
git add src/shared/messages.ts src/content/index.ts
git commit -m "feat: content script reports canonicalized page entity to service worker"
```

---

### Task 6: Event long-poll loop (`background/eventLoop.ts`)

**Files:**
- Create: `src/background/eventLoop.ts`
- Test: `src/background/eventLoop.test.ts`

**Interfaces:**
- Consumes: `ZulipClient`-shaped `{ register, getEvents }`, `ZulipError` from Task 4.
- Produces (used by Task 7):

```ts
interface EventLoopHooks {
  onEvent: (event: ZulipEvent) => void
  onReconnect?: () => void
  sleep?: (ms: number) => Promise<void>  // injectable for tests
}
class EventLoop {
  constructor(client: Pick<ZulipClient, 'register' | 'getEvents'>, channel: string, hooks: EventLoopHooks)
  start(): Promise<void>  // resolves when stopped
  stop(): void
}
```

- [ ] **Step 1: Write the failing tests**

`src/background/eventLoop.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { ZulipError } from '../shared/zulipClient'
import { EventLoop } from './eventLoop'

describe('EventLoop', () => {
  test('registers once, dispatches events, advances last_event_id', async () => {
    const calls: Array<[string, number]> = []
    let poll = 0
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: 'q1', lastEventId: -1 }),
      getEvents: async (queueId: string, lastEventId: number) => {
        calls.push([queueId, lastEventId])
        poll++
        if (poll === 1) {
          return [
            { id: 0, type: 'message' },
            { id: 1, type: 'heartbeat' },
          ]
        }
        loop.stop()
        return []
      },
    }
    const seen: number[] = []
    loop = new EventLoop(client, 'web-threads', { onEvent: (e) => seen.push(e.id) })
    await loop.start()
    expect(seen).toEqual([0, 1])
    expect(calls).toEqual([
      ['q1', -1],
      ['q1', 1],
    ])
  })

  test('re-registers on BAD_EVENT_QUEUE_ID and fires onReconnect', async () => {
    let registrations = 0
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: `q${++registrations}`, lastEventId: -1 }),
      getEvents: async (queueId: string) => {
        if (queueId === 'q1') throw new ZulipError('Bad event queue id', 'BAD_EVENT_QUEUE_ID')
        loop.stop()
        return []
      },
    }
    let reconnects = 0
    loop = new EventLoop(client, 'web-threads', {
      onEvent: () => {},
      onReconnect: () => reconnects++,
    })
    await loop.start()
    expect(registrations).toBe(2)
    expect(reconnects).toBe(1)
  })

  test('backs off exponentially on network errors, capped at 30s, reset on success', async () => {
    const sleeps: number[] = []
    let poll = 0
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: 'q1', lastEventId: -1 }),
      getEvents: async () => {
        poll++
        if (poll <= 6) throw new TypeError('fetch failed')
        if (poll === 7) return [{ id: 0, type: 'heartbeat' }] // success resets backoff
        if (poll === 8) throw new TypeError('fetch failed')
        loop.stop()
        return []
      },
    }
    loop = new EventLoop(client, 'web-threads', {
      onEvent: () => {},
      sleep: async (ms) => void sleeps.push(ms),
    })
    await loop.start()
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 1000])
  })

  test('stop() during a poll prevents further event dispatch', async () => {
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: 'q1', lastEventId: -1 }),
      getEvents: async () => {
        loop.stop()
        return [{ id: 0, type: 'message' }]
      },
    }
    const seen: number[] = []
    loop = new EventLoop(client, 'web-threads', { onEvent: (e) => seen.push(e.id) })
    await loop.start()
    expect(seen).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/background/eventLoop.test.ts`
Expected: FAIL — cannot resolve `./eventLoop`.

- [ ] **Step 3: Implement**

`src/background/eventLoop.ts`:

```ts
import type { ZulipClient, ZulipEvent } from '../shared/zulipClient'
import { ZulipError } from '../shared/zulipClient'

export interface EventLoopHooks {
  onEvent: (event: ZulipEvent) => void
  onReconnect?: () => void
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000

export class EventLoop {
  private running = false

  constructor(
    private client: Pick<ZulipClient, 'register' | 'getEvents'>,
    private channel: string,
    private hooks: EventLoopHooks
  ) {}

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const sleep = this.hooks.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    let backoff = INITIAL_BACKOFF_MS
    let queue: { queueId: string; lastEventId: number } | null = null

    while (this.running) {
      try {
        if (!queue) queue = await this.client.register(this.channel)
        const events = await this.client.getEvents(queue.queueId, queue.lastEventId)
        backoff = INITIAL_BACKOFF_MS
        for (const event of events) {
          if (event.id > queue.lastEventId) queue.lastEventId = event.id
          if (this.running) this.hooks.onEvent(event)
        }
      } catch (e) {
        if (!this.running) return
        if (e instanceof ZulipError && e.code === 'BAD_EVENT_QUEUE_ID') {
          queue = null
          this.hooks.onReconnect?.()
          continue
        }
        await sleep(backoff)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    }
  }

  stop(): void {
    this.running = false
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/background/eventLoop.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/background/eventLoop.ts src/background/eventLoop.test.ts
git commit -m "feat: Zulip event long-poll loop with backoff and queue recovery"
```

---

### Task 7: Service worker glue (`background/index.ts`)

**Files:**
- Modify: `src/background/index.ts` (replace placeholder)

**Interfaces:**
- Consumes: `ZulipClient` (Task 4), `EventLoop` (Task 6), protocol types (Task 5), `config` (Task 1).
- Produces: the SW side of the port protocol — panel connects with `chrome.runtime.connect({ name: 'panel' })`, sends `{type:'getActiveEntity'}`, receives `SwToPanel` messages.

Chrome-API glue; no unit test (all logic it composes is tested). Verified end-to-end in Task 10.

- [ ] **Step 1: Implement**

`src/background/index.ts` (replace entire file):

```ts
import { config } from '../config'
import type { ContentToSw, PageEntity, PanelToSw, SwToPanel } from '../shared/messages'
import { ZulipClient } from '../shared/zulipClient'
import { EventLoop } from './eventLoop'

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

const tabEntities = new Map<number, PageEntity>()
const ports = new Set<chrome.runtime.Port>()
const client = new ZulipClient(config)
let loop: EventLoop | null = null

function broadcast(msg: SwToPanel): void {
  for (const port of ports) port.postMessage(msg)
}

chrome.runtime.onMessage.addListener((msg: ContentToSw, sender) => {
  if (msg.type === 'pageEntity' && sender.tab?.id != null) {
    tabEntities.set(sender.tab.id, { entityUri: msg.entityUri, title: msg.title })
  }
})

chrome.tabs.onRemoved.addListener((tabId) => tabEntities.delete(tabId))

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return
  ports.add(port)

  if (!loop) {
    loop = new EventLoop(client, config.channelName, {
      onEvent: (event) => {
        if (event.type === 'message' && event.message) {
          broadcast({ type: 'newMessage', topic: event.message.subject, message: event.message })
        }
      },
      onReconnect: () => broadcast({ type: 'reconnected' }),
    })
    void loop.start()
  }

  port.onMessage.addListener((msg: PanelToSw) => {
    if (msg.type === 'getActiveEntity') {
      void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
        const entity = tab?.id != null ? tabEntities.get(tab.id) ?? null : null
        const reply: SwToPanel = { type: 'activeEntity', entity }
        port.postMessage(reply)
      })
    }
  })

  port.onDisconnect.addListener(() => {
    ports.delete(port)
    if (ports.size === 0) {
      loop?.stop()
      loop = null
    }
  })
})
```

- [ ] **Step 2: Verify build and tests**

Run: `npm run build && npm test`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/background/index.ts
git commit -m "feat: service worker tab-entity map, panel ports, event fan-out"
```

---

### Task 8: Panel logic — thread state reducer and linkifier

**Files:**
- Create: `src/panel/threadState.ts`, `src/panel/linkify.ts`
- Test: `src/panel/threadState.test.ts`, `src/panel/linkify.test.ts`

**Interfaces:**
- Consumes: `ZulipMessage` (Task 4).
- Produces (used by Task 9):

```ts
type ThreadAction = { type: 'history'; messages: ZulipMessage[] } | { type: 'append'; message: ZulipMessage }
function threadReducer(messages: ZulipMessage[], action: ThreadAction): ZulipMessage[]

type Segment = { kind: 'text'; value: string } | { kind: 'link'; value: string }
function splitLinks(text: string): Segment[]
```

- [ ] **Step 1: Write the failing tests**

`src/panel/threadState.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { threadReducer } from './threadState'

function msg(id: number): ZulipMessage {
  return { id, sender_full_name: 'A', sender_email: 'a@x', content: `m${id}`, timestamp: id, subject: 't' }
}

describe('threadReducer', () => {
  test('history replaces state sorted by id', () => {
    const out = threadReducer([msg(9)], { type: 'history', messages: [msg(3), msg(1), msg(2)] })
    expect(out.map((m) => m.id)).toEqual([1, 2, 3])
  })

  test('append adds in id order', () => {
    const out = threadReducer([msg(1), msg(3)], { type: 'append', message: msg(2) })
    expect(out.map((m) => m.id)).toEqual([1, 2, 3])
  })

  test('append dedupes by id (own message arrives via refetch AND event)', () => {
    const state = [msg(1), msg(2)]
    expect(threadReducer(state, { type: 'append', message: msg(2) })).toBe(state)
  })
})
```

`src/panel/linkify.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { splitLinks } from './linkify'

describe('splitLinks', () => {
  test('plain text yields one text segment', () => {
    expect(splitLinks('hello world')).toEqual([{ kind: 'text', value: 'hello world' }])
  })

  test('url in the middle yields text/link/text', () => {
    expect(splitLinks('see https://example.com/a?b=1 for details')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', value: 'https://example.com/a?b=1' },
      { kind: 'text', value: ' for details' },
    ])
  })

  test('bare url yields one link segment', () => {
    expect(splitLinks('http://localhost:9090/x')).toEqual([
      { kind: 'link', value: 'http://localhost:9090/x' },
    ])
  })

  test('multiple urls', () => {
    expect(splitLinks('a https://x.com b https://y.com')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'link', value: 'https://x.com' },
      { kind: 'text', value: ' b ' },
      { kind: 'link', value: 'https://y.com' },
    ])
  })

  test('empty string yields no segments', () => {
    expect(splitLinks('')).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/panel/threadState.test.ts src/panel/linkify.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/panel/threadState.ts`:

```ts
import type { ZulipMessage } from '../shared/zulipClient'

export type ThreadAction =
  | { type: 'history'; messages: ZulipMessage[] }
  | { type: 'append'; message: ZulipMessage }

export function threadReducer(messages: ZulipMessage[], action: ThreadAction): ZulipMessage[] {
  switch (action.type) {
    case 'history':
      return [...action.messages].sort((a, b) => a.id - b.id)
    case 'append':
      if (messages.some((m) => m.id === action.message.id)) return messages
      return [...messages, action.message].sort((a, b) => a.id - b.id)
  }
}
```

`src/panel/linkify.ts`:

```ts
export type Segment = { kind: 'text'; value: string } | { kind: 'link'; value: string }

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

/** Split plain text into text/link segments for safe rendering (no innerHTML). */
export function splitLinks(text: string): Segment[] {
  const segments: Segment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    if (start > last) segments.push({ kind: 'text', value: text.slice(last, start) })
    segments.push({ kind: 'link', value: m[0] })
    last = start + m[0].length
  }
  if (last < text.length) segments.push({ kind: 'text', value: text.slice(last) })
  return segments
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/panel/threadState.test.ts src/panel/linkify.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/panel/threadState.ts src/panel/threadState.test.ts src/panel/linkify.ts src/panel/linkify.test.ts
git commit -m "feat: panel thread-state reducer and plain-text linkifier"
```

---

### Task 9: Panel UI — components and wiring

**Files:**
- Create: `src/panel/App.tsx`, `src/panel/ThreadView.tsx`, `src/panel/Composer.tsx`
- Modify: `src/panel/main.tsx`, `src/panel/style.css`
- Test: `src/panel/ThreadView.test.tsx`, `src/panel/Composer.test.tsx`

**Interfaces:**
- Consumes: everything above — `config`, `ZulipClient`, `topicKey`/`topicName`/`matchTopicByKey`, `threadReducer`, `splitLinks`, port protocol types.
- Produces: the complete panel app.

- [ ] **Step 1: Write the failing component tests**

`src/panel/ThreadView.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { render, screen } from '@testing-library/preact'
import { describe, expect, test } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { ThreadView } from './ThreadView'

function msg(id: number, content: string): ZulipMessage {
  return { id, sender_full_name: 'Ada', sender_email: 'ada@x.com', content, timestamp: 1700000000, subject: 'T · k' }
}

describe('ThreadView', () => {
  test('shows empty state when no thread exists', () => {
    render(<ThreadView messages={[]} hasThread={false} />)
    expect(screen.getByText('No discussion yet. Start one.')).toBeTruthy()
  })

  test('renders sender and content', () => {
    render(<ThreadView messages={[msg(1, 'hello there')]} hasThread={true} />)
    expect(screen.getByText('Ada')).toBeTruthy()
    expect(screen.getByText('hello there')).toBeTruthy()
  })

  test('renders URLs in messages as safe links', () => {
    render(<ThreadView messages={[msg(1, 'see https://example.com/x')]} hasThread={true} />)
    const a = screen.getByRole('link') as HTMLAnchorElement
    expect(a.href).toBe('https://example.com/x')
    expect(a.rel).toContain('noopener')
    expect(a.target).toBe('_blank')
  })

  test('message content is rendered as text, not HTML', () => {
    const { container } = render(
      <ThreadView messages={[msg(1, '<img src=x onerror=alert(1)>')]} hasThread={true} />
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
  })
})
```

`src/panel/Composer.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, test, vi } from 'vitest'
import { Composer } from './Composer'

describe('Composer', () => {
  test('sends trimmed text on submit and clears the box', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} disabled={false} />)
    const box = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: '  hello  ' } })
    fireEvent.submit(box.closest('form')!)
    expect(onSend).toHaveBeenCalledWith('hello')
    expect(box.value).toBe('')
  })

  test('does not send empty text', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} disabled={false} />)
    fireEvent.submit(screen.getByPlaceholderText('Write a message…').closest('form')!)
    expect(onSend).not.toHaveBeenCalled()
  })

  test('disabled state disables the controls', () => {
    render(<Composer onSend={() => {}} disabled={true} />)
    expect((screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement).disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/panel/ThreadView.test.tsx src/panel/Composer.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the components**

`src/panel/ThreadView.tsx`:

```tsx
import type { ZulipMessage } from '../shared/zulipClient'
import { splitLinks } from './linkify'

export function ThreadView({ messages, hasThread }: { messages: ZulipMessage[]; hasThread: boolean }) {
  if (!hasThread && messages.length === 0) {
    return <div class="empty">No discussion yet. Start one.</div>
  }
  return (
    <ul class="messages">
      {messages.map((m) => (
        <li key={m.id}>
          <div class="meta">
            <span class="sender">{m.sender_full_name}</span>
            <span class="time">{new Date(m.timestamp * 1000).toLocaleString()}</span>
          </div>
          <div class="body">
            {m.content.split('\n').map((line, i) => (
              <p key={i}>
                {splitLinks(line).map((seg) =>
                  seg.kind === 'link' ? (
                    <a href={seg.value} target="_blank" rel="noopener noreferrer">
                      {seg.value}
                    </a>
                  ) : (
                    seg.value
                  )
                )}
              </p>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}
```

`src/panel/Composer.tsx`:

```tsx
import { useState } from 'preact/hooks'

export function Composer({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  const [text, setText] = useState('')

  function submit(e: Event) {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <form class="composer" onSubmit={submit}>
      <textarea
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e)
        }}
        placeholder="Write a message…"
        disabled={disabled}
      />
      <button type="submit" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  )
}
```

- [ ] **Step 4: Run component tests to verify they pass**

Run: `npx vitest run src/panel/ThreadView.test.tsx src/panel/Composer.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Implement App and wiring**

`src/panel/App.tsx`:

```tsx
import { useEffect, useReducer, useRef, useState } from 'preact/hooks'
import { config } from '../config'
import type { PageEntity, PanelToSw, SwToPanel } from '../shared/messages'
import { matchTopicByKey, topicKey, topicName } from '../shared/topic'
import { ZulipClient } from '../shared/zulipClient'
import { Composer } from './Composer'
import { ThreadView } from './ThreadView'
import { threadReducer } from './threadState'

const client = new ZulipClient(config)

interface Thread {
  entity: PageEntity
  key: string
  /** Exact topic name on the server, or null when no discussion exists yet. */
  existingTopic: string | null
}

function headerMessage(entity: PageEntity): string {
  const representativeUrl = entity.entityUri.replace(/^web:/, '')
  return [
    `🔗 Discussion for: ${entity.title}`,
    `Entity: \`${entity.entityUri}\` (resolver web@1)`,
    `Link: ${representativeUrl}`,
    `Started by ${config.email}`,
  ].join('\n')
}

export function App() {
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, dispatch] = useReducer(threadReducer, [])
  const [error, setError] = useState<string | null>(null)
  const threadRef = useRef<Thread | null>(null)
  threadRef.current = thread

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'panel' })
    port.onMessage.addListener((msg: SwToPanel) => {
      if (msg.type === 'activeEntity') {
        if (msg.entity) {
          initThread(msg.entity).catch((e) => setError(errText(e)))
        } else {
          setError('No page detected. Reload the tab, then reopen the panel.')
        }
      } else if (msg.type === 'newMessage') {
        const t = threadRef.current
        if (t?.existingTopic && msg.topic === t.existingTopic) {
          dispatch({ type: 'append', message: msg.message })
        }
      } else if (msg.type === 'reconnected') {
        const t = threadRef.current
        if (t?.existingTopic) loadHistory(t.existingTopic).catch(() => {})
      }
    })
    const req: PanelToSw = { type: 'getActiveEntity' }
    port.postMessage(req)
    return () => port.disconnect()
  }, [])

  async function initThread(entity: PageEntity) {
    const key = await topicKey(entity.entityUri)
    const streamId = await client.getStreamId(config.channelName)
    const topics = await client.getTopics(streamId)
    const existingTopic = matchTopicByKey(topics, key)
    setThread({ entity, key, existingTopic })
    if (existingTopic) await loadHistory(existingTopic)
  }

  async function loadHistory(topic: string) {
    dispatch({ type: 'history', messages: await client.getMessages(config.channelName, topic) })
  }

  async function send(text: string) {
    const t = threadRef.current
    if (!t) return
    setError(null)
    try {
      let topic = t.existingTopic
      if (!topic) {
        topic = topicName(t.entity.title, t.key)
        // Header first (spec §6.2); on failure retry once, then proceed regardless —
        // the topicKey suffix still makes the thread resolvable.
        try {
          await client.sendMessage(config.channelName, topic, headerMessage(t.entity))
        } catch {
          await client.sendMessage(config.channelName, topic, headerMessage(t.entity)).catch(() => {})
        }
        setThread({ ...t, existingTopic: topic })
      }
      await client.sendMessage(config.channelName, topic, text)
      await loadHistory(topic)
    } catch (e) {
      setError(errText(e))
    }
  }

  return (
    <div class="app">
      <header title={thread?.entity.entityUri}>{thread ? thread.entity.title : 'PageThreads'}</header>
      {error && (
        <div class="error" role="alert" onClick={() => setError(null)}>
          {error} <small>(click to dismiss)</small>
        </div>
      )}
      <ThreadView messages={messages} hasThread={!!thread?.existingTopic} />
      <Composer onSend={(text) => void send(text)} disabled={!thread} />
    </div>
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
```

`src/panel/main.tsx` (replace entire file):

```tsx
import { render } from 'preact'
import { App } from './App'

render(<App />, document.getElementById('root')!)
```

`src/panel/style.css` (replace entire file):

```css
:root { font-family: system-ui, sans-serif; font-size: 14px; }
* { box-sizing: border-box; }
body { margin: 0; }

.app { display: flex; flex-direction: column; height: 100vh; }

header {
  padding: 8px 12px;
  font-weight: 600;
  border-bottom: 1px solid #ddd;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.error {
  background: #fdecea;
  color: #b3261e;
  padding: 8px 12px;
  cursor: pointer;
}

.empty { flex: 1; display: grid; place-items: center; color: #777; padding: 16px; }

.messages { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 8px 12px; }
.messages li { margin-bottom: 12px; }
.meta { display: flex; gap: 8px; align-items: baseline; }
.sender { font-weight: 600; }
.time { color: #999; font-size: 12px; }
.body p { margin: 2px 0; overflow-wrap: anywhere; }

.composer { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid #ddd; }
.composer textarea { flex: 1; resize: none; height: 60px; padding: 6px; }
.composer button { align-self: flex-end; }
```

- [ ] **Step 6: Verify full build and test suite**

Run: `npm run build && npm test`
Expected: both exit 0; all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/panel/
git commit -m "feat: side panel app - topic resolution, history, composer, live append"
```

---

### Task 10: Local Zulip dev server, README, and manual end-to-end acceptance

**Files:**
- Create: `dev/zulip/README.md`, `README.md`

**Interfaces:**
- Consumes: the built extension from all prior tasks.
- Produces: reproducible dev-backend bootstrap + the M0 acceptance run.

- [ ] **Step 1: Write the dev-backend bootstrap doc**

`dev/zulip/README.md`:

````markdown
# Local Zulip for PageThreads development

Uses [zulip/docker-zulip](https://github.com/zulip/docker-zulip). Test traffic never
leaves your machine.

## First-time setup

```bash
git clone --depth 1 https://github.com/zulip/docker-zulip.git
cd docker-zulip
```

Edit `docker-compose.yml` under the `zulip:` service:

1. Change the port mapping to `"9090:80"` (and remove/ignore the 443 mapping).
2. In `environment:`, set:
   - `SETTING_EXTERNAL_HOST: "localhost:9090"`
   - `SETTING_ZULIP_ADMINISTRATOR: "you@example.com"`
   - `DISABLE_HTTPS: "True"`  (Chrome treats http://localhost as a secure context,
     and it avoids self-signed-cert issues with extension fetches)

Then:

```bash
docker compose up -d          # first boot takes a few minutes
docker compose exec zulip \
  sudo -u zulip /home/zulip/deployments/current/manage.py generate_realm_creation_link
```

Open the printed link (replace the host with `localhost:9090` if needed) and create
the organization and your admin account.

> If any setting name above has drifted in docker-zulip, `docker compose logs zulip`
> says so explicitly; the authoritative list is in docker-zulip's README table of
> `SETTING_*`/`DISABLE_HTTPS` variables.

## Per-realm setup for PageThreads

1. In Zulip (http://localhost:9090): create a channel named **web-threads**
   (gear icon → Channel settings → Create channel). Subscribe yourself.
2. Personal settings → Account & privacy → API key → copy it.
3. In this repo: `cp src/config.example.ts src/config.ts` and fill in
   `realmUrl: 'http://localhost:9090'`, your email, the API key.

## Second test user (for the live-updates acceptance check)

Invite a second user (Settings → Users → Invite) or reuse the realm-creation flow,
give them their own API key, and use them from a second Chrome profile with its own
`src/config.ts` build — or simply post as them from the Zulip web UI.
````

- [ ] **Step 2: Write the project README with build + acceptance checklist**

`README.md`:

````markdown
# PageThreads

A Manifest V3 browser extension that attaches a live discussion thread to any web
page, using a Zulip realm as the backend. Spec: [WHAT.md](WHAT.md). Current state:
**M0 walking skeleton** (see `docs/superpowers/specs/`).

## Build

```bash
npm install
cp src/config.example.ts src/config.ts   # then fill in realm URL, email, API key
npm run build
npm test
```

Backend for development: see [dev/zulip/README.md](dev/zulip/README.md).

## Load in Chrome

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.
2. Navigate to any http(s) page, click the PageThreads toolbar icon to open the
   side panel.

## M0 acceptance checklist

- [ ] `npm run build` produces a loadable unpacked extension in `dist/`.
- [ ] On a fresh page, the panel shows "No discussion yet. Start one."
- [ ] Posting creates the topic in Zulip (`#web-threads`) with a 🔗 header message
      followed by the posted message; the topic name ends in `· <16-char key>`.
- [ ] Opening the same URL **with `?utm_source=x&gclid=y` appended** resolves the
      same thread and shows the same messages.
- [ ] A message posted from the Zulip web UI into the topic appears in the open
      panel without a refresh (long-poll fan-out).
- [ ] A second Chrome profile (second Zulip user) on the same page sees new
      messages live.
- [ ] REST failures (e.g. stop the Zulip container, then send) show the dismissible
      error bar, and sending works again after the container is back.
````

- [ ] **Step 3: Bring up the backend and run the acceptance checklist manually**

Run through `dev/zulip/README.md`, then every box in the README checklist, in order.
Expected: every box checks. Fix-forward anything that fails (using superpowers:systematic-debugging) before committing.

- [ ] **Step 4: Commit**

```bash
git add dev/zulip/README.md README.md
git commit -m "docs: dev Zulip bootstrap and M0 acceptance checklist"
```

---

## Plan self-review notes

- **Spec coverage:** build pipeline (T1), canonicalizer §4.4 (T2), topicKey/name §4.6 (T3), REST client §5 (T4), content script §3.1 (T5), event loop + backoff + BAD_EVENT_QUEUE_ID §3.2/§8 (T6), SW glue + port fan-out (T7), reducer/linkify + escaped rendering §7 (T8), panel flows §6.1/§6.2 incl. header message + error bar + reconnect refetch (T9), dev backend + acceptance §"Testing" (T10). No gaps found.
- **Type consistency:** `PageEntity`/`SwToPanel` (T5) used verbatim in T7/T9; `ZulipMessage.subject` is the topic field used for event filtering; `EventLoop` hooks match between T6 and T7.
- **Known deferred items** (per spec, not plan gaps): auth flow, badge, SPA nav, Markdown, offline cache, Firefox.

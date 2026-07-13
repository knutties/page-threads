# PageThreads M1c — Message Features + Backlog Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zulip-faithful sanitized message rendering (click-to-load images), edit/delete own messages, reactions, read-marker sync — plus all eight accumulated backlog fixes.

**Architecture:** `apply_markdown` flips to true so content is Zulip-rendered HTML end-to-end; `panel/renderMessage.ts` (DOMPurify) becomes the single place HTML enters the DOM, with images rewritten to click-to-load placeholders. The SW registers `update_message`/`delete_message`/`reaction` events and its loop/credential wiring extracts into a unit-testable `background/lifecycle.ts`. A new `MessageView` component carries actions/reactions/edit; `threadReducer` gains update/remove/reaction merges; `panel/readMarker.ts` batches read flags. App picks up the remaining backlog items (credentials watch, sendingRef latch, init generation token).

**Tech Stack:** Existing stack + **dompurify** (only new dependency; v3 ships its own types).

**Spec:** `docs/superpowers/specs/2026-07-13-m1c-message-features-design.md`.

## Global Constraints

- `renderMessage.ts` is the ONLY place HTML is injected (`dangerouslySetInnerHTML` appears nowhere else); everything it emits passed DOMPurify with the explicit allowlist.
- No `<img>` survives sanitization — images become `<button class="img-placeholder" type="button" data-src="…">`; remote fetch happens only on user click.
- `a[href]` http(s) only, resolved absolute against the stored realm; every `a` gets `target="_blank" rel="noopener noreferrer"`.
- Reaction identity key: `emoji_code + reaction_type + user_id` (server field names, matching existing `ZulipMessage` style — spec's camelCase illustration intentionally not used; same precedent as `passwordAuthEnabled`).
- Read flags: `POST /messages/flags` `{messages, op:'add', flag:'read'}`, debounce 2000 ms, dedupe against all previously flushed ids, failed ids stay queued.
- Two existing zulipClient tests change deliberately (spec-mandated): `apply_markdown` false→true in getMessages, register `event_types` gains the three new types. No other existing test may change.
- Version bumps to `0.3.0` in `package.json` + `public/manifest.json` (Task 8). Existing 132 tests (minus the two amended assertions) keep passing.
- Branch `m1c-message-features` off main. Commit trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LpgtuXYp32egiB82M3qkAb`

---

### Task 1: Sanitized rendering (`panel/renderMessage.ts`) + dompurify

**Files:**
- Create: `src/panel/renderMessage.ts`
- Modify: `package.json` (dependency)
- Test: `src/panel/renderMessage.test.ts`

**Interfaces:**
- Produces (consumed by Task 6): `sanitizeMessageHtml(html: string, realmUrl: string): string`

- [ ] **Step 1: Install dompurify**

Run: `npm install dompurify` (v3.x; ships its own TypeScript types — do NOT add @types/dompurify).

- [ ] **Step 2: Write the failing tests**

`src/panel/renderMessage.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest'
import { sanitizeMessageHtml } from './renderMessage'

const REALM = 'https://zulip.example.com'
const s = (html: string) => sanitizeMessageHtml(html, REALM)

describe('sanitizeMessageHtml — XSS corpus', () => {
  test.each([
    ['<script>alert(1)</script><p>hi</p>', 'script'],
    ['<style>*{display:none}</style><p>hi</p>', 'style'],
    ['<iframe src="https://evil.com"></iframe><p>hi</p>', 'iframe'],
    ['<form action="https://evil.com"><input></form><p>hi</p>', 'form'],
    ['<svg onload="alert(1)"></svg><p>hi</p>', 'svg'],
    ['<object data="x"></object><p>hi</p>', 'object'],
  ])('strips %s', (input, tag) => {
    const out = s(input)
    expect(out).not.toContain(`<${tag}`)
    expect(out).toContain('<p>hi</p>')
  })

  test('strips event handlers', () => {
    expect(s('<p onclick="alert(1)">hi</p>')).not.toContain('onclick')
  })

  test('javascript: href is removed', () => {
    const out = s('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('<a')
    expect(out).not.toContain('href=')
  })

  test('data: href is removed', () => {
    expect(s('<a href="data:text/html,x">x</a>')).not.toContain('href=')
  })
})

describe('sanitizeMessageHtml — images become click-to-load placeholders', () => {
  test('absolute remote image', () => {
    const out = s('<p><img src="https://cdn.example.com/x.png" alt="x"></p>')
    expect(out).not.toContain('<img')
    expect(out).toContain('class="img-placeholder"')
    expect(out).toContain('data-src="https://cdn.example.com/x.png"')
    expect(out).toContain('type="button"')
  })

  test('realm-relative upload resolves against the realm', () => {
    const out = s('<img src="/user_uploads/2/ab/x.png">')
    expect(out).toContain(`data-src="${REALM}/user_uploads/2/ab/x.png"`)
  })

  test('img with onerror produces a clean placeholder', () => {
    const out = s('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<img')
    expect(out).toContain('img-placeholder')
  })

  test('non-http image source yields placeholder without data-src', () => {
    const out = s('<img src="data:image/png;base64,AAAA">')
    expect(out).toContain('img-placeholder')
    expect(out).not.toContain('data-src')
  })
})

describe('sanitizeMessageHtml — Zulip markup passes', () => {
  test('mention spans, code blocks, quotes, tables survive', () => {
    const zulip =
      '<p><span class="user-mention" data-user-id="7">@Ada</span></p>' +
      '<blockquote><p>q</p></blockquote>' +
      '<div class="codehilite"><pre><code>x = 1</code></pre></div>' +
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>'
    const out = s(zulip)
    expect(out).toContain('user-mention')
    expect(out).toContain('<blockquote>')
    expect(out).toContain('<pre>')
    expect(out).toContain('<table>')
    expect(out).not.toContain('data-user-id') // attribute not allowlisted
  })

  test('links open safely in a new tab', () => {
    const out = s('<a href="https://example.com/x">x</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  test('realm-relative #narrow link becomes absolute', () => {
    const out = s('<a href="/#narrow/channel/4/topic/T">x</a>')
    expect(out).toContain(`href="${REALM}/#narrow/channel/4/topic/T"`)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/panel/renderMessage.test.ts`
Expected: FAIL — cannot resolve `./renderMessage`.

- [ ] **Step 4: Implement**

`src/panel/renderMessage.ts`:

```ts
import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'p', 'div', 'span', 'a', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ol', 'ul', 'li', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'time', 'sup', 'sub', 'details', 'summary',
  'img', // never emitted: rewritten to a placeholder button by the hook below
  'button', // only the placeholders we create ourselves
]

const ALLOWED_ATTR = ['href', 'title', 'class', 'datetime', 'start', 'align', 'src', 'data-src', 'type']

function resolveHttpUrl(raw: string, realmUrl: string): string | null {
  try {
    const u = new URL(raw, realmUrl)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/**
 * The single gate through which message HTML enters the DOM (spec §Rendering).
 * Zulip-rendered HTML in; sanitized HTML with click-to-load image placeholders out.
 */
export function sanitizeMessageHtml(html: string, realmUrl: string): string {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href')
      const abs = href ? resolveHttpUrl(href, realmUrl) : null
      if (abs) node.setAttribute('href', abs)
      else node.removeAttribute('href')
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src')
      const abs = src ? resolveHttpUrl(src, realmUrl) : null
      const doc = node.ownerDocument
      const button = doc.createElement('button')
      button.setAttribute('type', 'button')
      button.setAttribute('class', 'img-placeholder')
      if (abs) button.setAttribute('data-src', abs)
      button.textContent = '🖼️ Load image'
      node.replaceWith(button)
    }
    if (node.tagName === 'BUTTON' && node.getAttribute('class') !== 'img-placeholder') {
      // The only buttons we allow are the placeholders we just created.
      node.remove()
    }
  })
  try {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR })
  } finally {
    DOMPurify.removeAllHooks()
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/panel/renderMessage.test.ts`
Expected: PASS (15 tests). Then `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/panel/renderMessage.ts src/panel/renderMessage.test.ts
git commit -m "feat: DOMPurify message sanitizer with click-to-load image placeholders"
```

---

### Task 2: ZulipClient — rendered content, edit/delete, reactions, read flags

**Files:**
- Modify: `src/shared/zulipClient.ts`
- Modify: `src/shared/zulipClient.test.ts` (two amended assertions + one appended describe block)

**Interfaces:**
- Produces (consumed by Tasks 3, 5, 6, 7):

```ts
interface ZulipReaction { emoji_name: string; emoji_code: string; reaction_type: string; user_id: number }
// ZulipMessage gains: reactions?: ZulipReaction[]
// ZulipEvent gains optional: message_id, rendered_content, op ('add'|'remove'), emoji_name, emoji_code, reaction_type, user_id
client.getRawMessage(id: number): Promise<string>
client.updateMessage(id: number, content: string): Promise<void>
client.deleteMessage(id: number): Promise<void>
client.addReaction(id: number, emojiName: string): Promise<void>
client.removeReaction(id: number, emojiName: string): Promise<void>
client.markRead(ids: number[]): Promise<void>
client.getOwnUser(): Promise<{ email: string; fullName: string; userId: number }>   // userId added
// getMessages now sends apply_markdown: true; register sends event_types ['message','update_message','delete_message','reaction']
```

- [ ] **Step 1: Amend the two spec-mandated assertions**

In `src/shared/zulipClient.test.ts`:
1. In the test `'GET params go in the query string, JSON-encoding non-strings'`, change
   `expect(url.searchParams.get('apply_markdown')).toBe('false')` → `toBe('true')`.
2. In the test `'register maps queue fields and narrows to the channel'`, change
   `expect(JSON.parse(body.get('event_types')!)).toEqual(['message'])` →
   `toEqual(['message', 'update_message', 'delete_message', 'reaction'])`.

These are the ONLY permitted edits to existing tests (Global Constraints).

- [ ] **Step 2: Append the failing tests**

Append to `src/shared/zulipClient.test.ts`:

```ts
describe('message features endpoints', () => {
  function capture(payload: unknown) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fn = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(payload))
    }) as typeof fetch
    return { fn, calls }
  }

  test('getRawMessage fetches a single message unrendered', async () => {
    const { fn, calls } = capture({ result: 'success', message: { content: '**raw**' } })
    expect(await new ZulipClient(cfg, fn).getRawMessage(42)).toBe('**raw**')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/v1/messages/42')
    expect(url.searchParams.get('apply_markdown')).toBe('false')
  })

  test('updateMessage PATCHes content', async () => {
    const { fn, calls } = capture({ result: 'success' })
    await new ZulipClient(cfg, fn).updateMessage(42, 'new text')
    expect(calls[0].init!.method).toBe('PATCH')
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/messages/42')
    expect((calls[0].init!.body as URLSearchParams).get('content')).toBe('new text')
  })

  test('deleteMessage DELETEs', async () => {
    const { fn, calls } = capture({ result: 'success' })
    await new ZulipClient(cfg, fn).deleteMessage(42)
    expect(calls[0].init!.method).toBe('DELETE')
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/messages/42')
  })

  test('addReaction / removeReaction hit the reactions resource', async () => {
    const { fn, calls } = capture({ result: 'success' })
    const client = new ZulipClient(cfg, fn)
    await client.addReaction(42, 'thumbs_up')
    await client.removeReaction(42, 'thumbs_up')
    expect(calls[0].init!.method).toBe('POST')
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/messages/42/reactions')
    expect((calls[0].init!.body as URLSearchParams).get('emoji_name')).toBe('thumbs_up')
    expect(calls[1].init!.method).toBe('DELETE')
    expect((calls[1].init!.body as URLSearchParams).get('emoji_name')).toBe('thumbs_up')
  })

  test('markRead posts message ids with the read flag', async () => {
    const { fn, calls } = capture({ result: 'success', messages: [1, 2] })
    await new ZulipClient(cfg, fn).markRead([1, 2])
    expect(calls[0].init!.method).toBe('POST')
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/messages/flags')
    const body = calls[0].init!.body as URLSearchParams
    expect(JSON.parse(body.get('messages')!)).toEqual([1, 2])
    expect(body.get('op')).toBe('add')
    expect(body.get('flag')).toBe('read')
  })

  test('getOwnUser includes userId', async () => {
    const { fn } = capture({
      result: 'success',
      email: 'e',
      delivery_email: 'me@x.com',
      full_name: 'Me',
      user_id: 17,
    })
    expect(await new ZulipClient(cfg, fn).getOwnUser()).toEqual({
      email: 'me@x.com',
      fullName: 'Me',
      userId: 17,
    })
  })
})
```

- [ ] **Step 3: Run to verify red**

Run: `npx vitest run src/shared/zulipClient.test.ts`
Expected: the 2 amended tests FAIL (old behavior) and the 6 new tests FAIL (methods missing).

- [ ] **Step 4: Implement**

In `src/shared/zulipClient.ts`:

1. Add after `ZulipMessage`:

```ts
export interface ZulipReaction {
  emoji_name: string
  emoji_code: string
  reaction_type: string
  user_id: number
}
```

and add to `ZulipMessage`: `reactions?: ZulipReaction[]`.

2. Extend `ZulipEvent` with optional fields:

```ts
export interface ZulipEvent {
  id: number
  type: string
  message?: ZulipMessage
  message_id?: number
  rendered_content?: string
  op?: 'add' | 'remove'
  emoji_name?: string
  emoji_code?: string
  reaction_type?: string
  user_id?: number
}
```

3. Widen `request`'s method union to `'GET' | 'POST' | 'PATCH' | 'DELETE'`; params go in the query string for GET, in the form body for POST/PATCH/DELETE (change the existing `if (method === 'GET')` to keep GET behavior and put the body on every other method).

4. `getMessages`: `apply_markdown: false` → `apply_markdown: true`.

5. `register`: `event_types: ['message', 'update_message', 'delete_message', 'reaction']`.

6. Add response interfaces + methods:

```ts
export interface GetSingleMessageResponse extends ZulipSuccess {
  message: { content: string }
}

  async getRawMessage(id: number): Promise<string> {
    const data = await this.request<GetSingleMessageResponse>('GET', `/messages/${id}`, {
      apply_markdown: false,
    })
    return data.message.content
  }

  async updateMessage(id: number, content: string): Promise<void> {
    await this.request<ZulipSuccess>('PATCH', `/messages/${id}`, { content })
  }

  async deleteMessage(id: number): Promise<void> {
    await this.request<ZulipSuccess>('DELETE', `/messages/${id}`)
  }

  async addReaction(id: number, emojiName: string): Promise<void> {
    await this.request<ZulipSuccess>('POST', `/messages/${id}/reactions`, { emoji_name: emojiName })
  }

  async removeReaction(id: number, emojiName: string): Promise<void> {
    await this.request<ZulipSuccess>('DELETE', `/messages/${id}/reactions`, { emoji_name: emojiName })
  }

  async markRead(ids: number[]): Promise<void> {
    await this.request<ZulipSuccess>('POST', '/messages/flags', { messages: ids, op: 'add', flag: 'read' })
  }
```

(`ZulipSuccess` must be exported now — change `interface ZulipSuccess` to `export interface ZulipSuccess`.)

7. `getOwnUser` returns `userId`: add `user_id: number` to `GetOwnUserResponse` and return `{ email: …, fullName: …, userId: data.user_id }`.

- [ ] **Step 5: Run to verify green**

Run: `npx vitest run src/shared/zulipClient.test.ts && npx tsc --noEmit && npm test`
Expected: 22 zulipClient tests pass; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/zulipClient.ts src/shared/zulipClient.test.ts
git commit -m "feat: rendered content, edit/delete, reactions, read flags on ZulipClient"
```

---

### Task 3: threadReducer — update, remove, reaction merge

**Files:**
- Modify: `src/panel/threadState.ts`
- Modify: `src/panel/threadState.test.ts` (append)

**Interfaces:**
- Consumes: `ZulipReaction` (Task 2).
- Produces (consumed by Task 7):

```ts
type ThreadAction =
  | { type: 'history'; messages: ZulipMessage[] }
  | { type: 'append'; message: ZulipMessage }
  | { type: 'update'; id: number; content: string }
  | { type: 'remove'; id: number }
  | { type: 'reaction'; op: 'add' | 'remove'; id: number; reaction: ZulipReaction }
```

- [ ] **Step 1: Append the failing tests**

Append inside the existing describe in `src/panel/threadState.test.ts` (the local `msg` helper already exists):

```ts
  test('update replaces content by id; unknown id is a no-op', () => {
    const state = [msg(1), msg(2)]
    const out = threadReducer(state, { type: 'update', id: 2, content: '<p>edited</p>' })
    expect(out.find((m) => m.id === 2)!.content).toBe('<p>edited</p>')
    expect(out.find((m) => m.id === 1)!.content).toBe('m1')
    expect(threadReducer(state, { type: 'update', id: 99, content: 'x' })).toBe(state)
  })

  test('remove deletes by id; unknown id is a no-op', () => {
    const state = [msg(1), msg(2)]
    expect(threadReducer(state, { type: 'remove', id: 1 }).map((m) => m.id)).toEqual([2])
    expect(threadReducer(state, { type: 'remove', id: 99 })).toBe(state)
  })

  test('reaction add appends once (idempotent) and remove deletes the matching entry', () => {
    const r = { emoji_name: '+1', emoji_code: '1f44d', reaction_type: 'unicode_emoji', user_id: 7 }
    const state = [msg(1)]
    const added = threadReducer(state, { type: 'reaction', op: 'add', id: 1, reaction: r })
    expect(added[0].reactions).toEqual([r])
    const addedTwice = threadReducer(added, { type: 'reaction', op: 'add', id: 1, reaction: r })
    expect(addedTwice[0].reactions).toEqual([r])
    const otherUser = threadReducer(added, { type: 'reaction', op: 'add', id: 1, reaction: { ...r, user_id: 8 } })
    expect(otherUser[0].reactions).toHaveLength(2)
    const removed = threadReducer(otherUser, { type: 'reaction', op: 'remove', id: 1, reaction: r })
    expect(removed[0].reactions).toEqual([{ ...r, user_id: 8 }])
    expect(threadReducer(state, { type: 'reaction', op: 'remove', id: 1, reaction: r })[0].reactions ?? []).toEqual([])
  })
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/panel/threadState.test.ts` — the 3 new tests FAIL (type errors / missing cases).

- [ ] **Step 3: Implement**

`src/panel/threadState.ts` (replace entire file):

```ts
import type { ZulipMessage, ZulipReaction } from '../shared/zulipClient'

export type ThreadAction =
  | { type: 'history'; messages: ZulipMessage[] }
  | { type: 'append'; message: ZulipMessage }
  | { type: 'update'; id: number; content: string }
  | { type: 'remove'; id: number }
  | { type: 'reaction'; op: 'add' | 'remove'; id: number; reaction: ZulipReaction }

const sameReaction = (a: ZulipReaction, b: ZulipReaction) =>
  a.emoji_code === b.emoji_code && a.reaction_type === b.reaction_type && a.user_id === b.user_id

export function threadReducer(messages: ZulipMessage[], action: ThreadAction): ZulipMessage[] {
  switch (action.type) {
    case 'history':
      return [...action.messages].sort((a, b) => a.id - b.id)
    case 'append':
      if (messages.some((m) => m.id === action.message.id)) return messages
      return [...messages, action.message].sort((a, b) => a.id - b.id)
    case 'update':
      if (!messages.some((m) => m.id === action.id)) return messages
      return messages.map((m) => (m.id === action.id ? { ...m, content: action.content } : m))
    case 'remove':
      if (!messages.some((m) => m.id === action.id)) return messages
      return messages.filter((m) => m.id !== action.id)
    case 'reaction':
      return messages.map((m) => {
        if (m.id !== action.id) return m
        const current = m.reactions ?? []
        if (action.op === 'add') {
          if (current.some((r) => sameReaction(r, action.reaction))) return m
          return { ...m, reactions: [...current, action.reaction] }
        }
        return { ...m, reactions: current.filter((r) => !sameReaction(r, action.reaction)) }
      })
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/panel/threadState.test.ts` — 6 tests pass. `npx tsc --noEmit` clean (App still only dispatches history/append — fine).

- [ ] **Step 5: Commit**

```bash
git add src/panel/threadState.ts src/panel/threadState.test.ts
git commit -m "feat: thread reducer handles edits, deletions, and reaction merges"
```

---

### Task 4: Read-marker batcher (`panel/readMarker.ts`)

**Files:**
- Create: `src/panel/readMarker.ts`
- Test: `src/panel/readMarker.test.ts`

**Interfaces:**
- Produces (consumed by Task 7):

```ts
function createReadMarker(opts: {
  flush: (ids: number[]) => Promise<void>
  debounceMs?: number            // default 2000
  isVisible?: () => boolean      // default () => true; App passes document.visibilityState check
}): { noteRendered(ids: number[]): void; dispose(): void }
```

- [ ] **Step 1: Write the failing tests**

`src/panel/readMarker.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createReadMarker } from './readMarker'

describe('createReadMarker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('batches ids and flushes once after the debounce window', async () => {
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids) })
    m.noteRendered([1, 2])
    m.noteRendered([2, 3])
    expect(flushed).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1, 2, 3]])
  })

  test('never re-flushes ids that already succeeded', async () => {
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids) })
    m.noteRendered([1])
    await vi.advanceTimersByTimeAsync(2000)
    m.noteRendered([1, 2])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1], [2]])
  })

  test('failed ids stay queued and retry on the next flush', async () => {
    let fail = true
    const flushed: number[][] = []
    const m = createReadMarker({
      flush: async (ids) => {
        if (fail) throw new Error('offline')
        flushed.push(ids)
      },
    })
    m.noteRendered([1])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([])
    fail = false
    m.noteRendered([2])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1, 2]])
  })

  test('collects nothing while not visible; flushes after becoming visible', async () => {
    let visible = false
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids), isVisible: () => visible })
    m.noteRendered([1])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([])
    visible = true
    m.noteRendered([1])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1]])
  })

  test('dispose cancels pending work', async () => {
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids) })
    m.noteRendered([1])
    m.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(flushed).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/panel/readMarker.test.ts` — FAIL, module missing.

- [ ] **Step 3: Implement**

`src/panel/readMarker.ts`:

```ts
export interface ReadMarker {
  noteRendered(ids: number[]): void
  dispose(): void
}

/**
 * Batches read receipts: dedupes against everything already flushed,
 * debounces the POST, keeps failed ids queued for the next attempt.
 */
export function createReadMarker(opts: {
  flush: (ids: number[]) => Promise<void>
  debounceMs?: number
  isVisible?: () => boolean
}): ReadMarker {
  const debounceMs = opts.debounceMs ?? 2000
  const isVisible = opts.isVisible ?? (() => true)
  const pending = new Set<number>()
  const flushed = new Set<number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      const ids = [...pending]
      if (!ids.length) return
      pending.clear()
      opts
        .flush(ids)
        .then(() => {
          for (const id of ids) flushed.add(id)
        })
        .catch(() => {
          if (disposed) return
          for (const id of ids) pending.add(id) // retry on the next schedule
        })
    }, debounceMs)
  }

  return {
    noteRendered(ids) {
      if (disposed || !isVisible()) return
      let added = false
      for (const id of ids) {
        if (!flushed.has(id) && !pending.has(id)) {
          pending.add(id)
          added = true
        }
      }
      if (added || pending.size) schedule()
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run src/panel/readMarker.test.ts` — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/panel/readMarker.ts src/panel/readMarker.test.ts
git commit -m "feat: debounced deduplicating read-marker batcher"
```

---

### Task 5: SW lifecycle extraction + new events + push triggers

**Files:**
- Create: `src/background/lifecycle.ts`
- Modify: `src/background/index.ts`, `src/shared/messages.ts`
- Test: `src/background/lifecycle.test.ts`

**Interfaces:**
- Consumes: `Credentials` (existing), `ZulipReaction`/`ZulipEvent` (Task 2).
- Produces:

```ts
// lifecycle.ts
interface LoopLike { start(): Promise<void>; stop(): void }
function createLifecycle(deps: {
  loadCredentials(): Promise<Credentials | null>
  makeLoop(creds: Credentials): LoopLike
}): {
  init(): Promise<void>
  reloadCredentials(): Promise<void>       // credentialsChanged message path
  setCredentials(c: Credentials | null): void  // storage watch path
  portConnected(): void
  portDisconnected(): void
}
// messages.ts SwToPanel gains:
| { type: 'messageUpdated'; messageId: number; renderedContent: string }
| { type: 'messageDeleted'; messageId: number }
| { type: 'reactionChanged'; op: 'add' | 'remove'; messageId: number; reaction: ZulipReaction }
```

- [ ] **Step 1: Write the failing lifecycle tests**

`src/background/lifecycle.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { createLifecycle } from './lifecycle'

const CREDS = { realmUrl: 'https://a.com', email: 'e', apiKey: 'k', channelName: 'web-threads' }

function fakeLoopFactory() {
  const loops: Array<{ started: boolean; stopped: boolean; creds: unknown }> = []
  return {
    loops,
    makeLoop(creds: unknown) {
      const loop = { started: false, stopped: false, creds }
      loops.push(loop)
      return {
        start: async () => void (loop.started = true),
        stop: () => void (loop.stopped = true),
      }
    },
  }
}

describe('createLifecycle', () => {
  test('cold start: port connects before credentials load; loop starts once load resolves', async () => {
    const f = fakeLoopFactory()
    let resolveLoad!: (c: typeof CREDS | null) => void
    const lc = createLifecycle({
      loadCredentials: () => new Promise((r) => (resolveLoad = r)),
      makeLoop: f.makeLoop,
    })
    const init = lc.init()
    lc.portConnected()
    expect(f.loops).toHaveLength(0)
    resolveLoad(CREDS)
    await init
    expect(f.loops).toHaveLength(1)
    expect(f.loops[0].started).toBe(true)
  })

  test('no credentials → no loop; no ports → no loop', async () => {
    const f = fakeLoopFactory()
    const lc = createLifecycle({ loadCredentials: async () => null, makeLoop: f.makeLoop })
    await lc.init()
    lc.portConnected()
    expect(f.loops).toHaveLength(0)
    lc.portDisconnected()
    const lc2 = createLifecycle({ loadCredentials: async () => CREDS, makeLoop: f.makeLoop })
    await lc2.init()
    expect(f.loops).toHaveLength(0) // credentials but no port
  })

  test('setCredentials(null) stops the loop; new credentials restart it', async () => {
    const f = fakeLoopFactory()
    const lc = createLifecycle({ loadCredentials: async () => CREDS, makeLoop: f.makeLoop })
    await lc.init()
    lc.portConnected()
    expect(f.loops).toHaveLength(1)
    lc.setCredentials(null)
    expect(f.loops[0].stopped).toBe(true)
    lc.setCredentials({ ...CREDS, email: 'other' })
    expect(f.loops).toHaveLength(2)
    expect((f.loops[1].creds as typeof CREDS).email).toBe('other')
  })

  test('double restart never leaves two live loops', async () => {
    const f = fakeLoopFactory()
    const lc = createLifecycle({ loadCredentials: async () => CREDS, makeLoop: f.makeLoop })
    await lc.init()
    lc.portConnected()
    lc.setCredentials(CREDS)
    lc.setCredentials(CREDS)
    expect(f.loops).toHaveLength(3)
    expect(f.loops[0].stopped).toBe(true)
    expect(f.loops[1].stopped).toBe(true)
    expect(f.loops[2].stopped).toBe(false)
  })

  test('last port disconnect stops the loop; reconnect restarts it', async () => {
    const f = fakeLoopFactory()
    const lc = createLifecycle({ loadCredentials: async () => CREDS, makeLoop: f.makeLoop })
    await lc.init()
    lc.portConnected()
    lc.portConnected()
    lc.portDisconnected()
    expect(f.loops[0].stopped).toBe(false) // one port still connected
    lc.portDisconnected()
    expect(f.loops[0].stopped).toBe(true)
    lc.portConnected()
    expect(f.loops).toHaveLength(2)
  })

  test('reloadCredentials picks up the latest stored value', async () => {
    const f = fakeLoopFactory()
    let stored: typeof CREDS | null = CREDS
    const lc = createLifecycle({ loadCredentials: async () => stored, makeLoop: f.makeLoop })
    await lc.init()
    lc.portConnected()
    stored = null
    await lc.reloadCredentials()
    expect(f.loops[0].stopped).toBe(true)
    expect(f.loops).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/background/lifecycle.test.ts` — FAIL, module missing.

- [ ] **Step 3: Implement lifecycle**

`src/background/lifecycle.ts`:

```ts
import type { Credentials } from '../shared/credentials'

export interface LoopLike {
  start(): Promise<void>
  stop(): void
}

/**
 * Owns the (credentials × ports) → event-loop state machine, extracted from
 * the service worker so it is unit-testable (M1c backlog #2).
 */
export function createLifecycle(deps: {
  loadCredentials(): Promise<Credentials | null>
  makeLoop(creds: Credentials): LoopLike
}) {
  let credentials: Credentials | null = null
  let loop: LoopLike | null = null
  let ports = 0

  function evaluate(): void {
    if (loop || !credentials || ports === 0) return
    loop = deps.makeLoop(credentials)
    void loop.start()
  }

  function restart(): void {
    loop?.stop()
    loop = null
    evaluate()
  }

  return {
    async init() {
      credentials = await deps.loadCredentials()
      evaluate()
    },
    async reloadCredentials() {
      credentials = await deps.loadCredentials()
      restart()
    },
    setCredentials(c: Credentials | null) {
      credentials = c
      restart()
    },
    portConnected() {
      ports++
      evaluate()
    },
    portDisconnected() {
      ports--
      if (ports === 0) {
        loop?.stop()
        loop = null
      }
    },
  }
}
```

- [ ] **Step 4: Run lifecycle tests green**

Run: `npx vitest run src/background/lifecycle.test.ts` — 6 tests pass.

- [ ] **Step 5: Extend the port protocol**

In `src/shared/messages.ts`: add `ZulipReaction` to the type-import from `./zulipClient`, and extend `SwToPanel` with:

```ts
  | { type: 'messageUpdated'; messageId: number; renderedContent: string }
  | { type: 'messageDeleted'; messageId: number }
  | { type: 'reactionChanged'; op: 'add' | 'remove'; messageId: number; reaction: ZulipReaction }
```

- [ ] **Step 6: Rewire the service worker**

In `src/background/index.ts`:

1. Delete the `credentials`/`loop` variables, `startLoopIfReady`, `restartLoop`, and the `credentialsStore.load()/.watch()` bootstrap blocks. Replace with:

```ts
import { createLifecycle } from './lifecycle'

const lifecycle = createLifecycle({
  loadCredentials: () => credentialsStore.load(),
  makeLoop: (creds) =>
    new EventLoop(new ZulipClient(creds), creds.channelName, {
      onEvent: (event) => {
        if (event.type === 'message' && event.message) {
          broadcast({ type: 'newMessage', topic: event.message.subject, message: event.message })
        } else if (event.type === 'update_message' && event.message_id != null && event.rendered_content != null) {
          broadcast({ type: 'messageUpdated', messageId: event.message_id, renderedContent: event.rendered_content })
        } else if (event.type === 'delete_message' && event.message_id != null) {
          broadcast({ type: 'messageDeleted', messageId: event.message_id })
        } else if (
          event.type === 'reaction' &&
          event.message_id != null &&
          event.op != null &&
          event.emoji_name != null &&
          event.emoji_code != null &&
          event.reaction_type != null &&
          event.user_id != null
        ) {
          broadcast({
            type: 'reactionChanged',
            op: event.op,
            messageId: event.message_id,
            reaction: {
              emoji_name: event.emoji_name,
              emoji_code: event.emoji_code,
              reaction_type: event.reaction_type,
              user_id: event.user_id,
            },
          })
        }
      },
      onReconnect: () => broadcast({ type: 'reconnected' }),
    }),
})

void lifecycle.init()
credentialsStore.watch((c) => lifecycle.setCredentials(c))
```

2. The `credentialsChanged` branch of `onMessage` becomes `void lifecycle.reloadCredentials()`.
3. In `onConnect`: `startLoopIfReady()` → `lifecycle.portConnected()`. In the port's `onDisconnect`: replace the `if (ports.size === 0) { loop?.stop(); loop = null }` block with `lifecycle.portDisconnected()` (keep `ports.delete(port)`).
4. Backlog #4 — add near the other listeners:

```ts
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void pushActiveEntity()
})
```

5. Backlog #5 — add:

```ts
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A tab that navigated somewhere content scripts can't run must not keep a stale entity.
  if (info.status === 'loading' && info.url && !/^https?:/.test(info.url)) {
    tabEntities.delete(tabId)
    void pushActiveEntity()
  }
})
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm test && npm run build` — all green.

- [ ] **Step 8: Commit**

```bash
git add src/background/lifecycle.ts src/background/lifecycle.test.ts src/background/index.ts src/shared/messages.ts
git commit -m "feat: testable SW lifecycle module; edit/delete/reaction events; focus and nav push triggers"
```

---

### Task 6: MessageView + ThreadView rework

**Files:**
- Create: `src/panel/MessageView.tsx`
- Modify: `src/panel/ThreadView.tsx` (replace entire file), `src/panel/style.css` (append)
- Test: `src/panel/MessageView.test.tsx`, `src/panel/ThreadView.test.tsx` (replace entire file)

**Interfaces:**
- Consumes: `sanitizeMessageHtml` (T1), `ZulipMessage`/`ZulipReaction` (T2), `shouldStickToBottom` (existing).
- Produces (consumed by Task 7):

```tsx
QUICK_REACTIONS: Array<{ emoji_name: string; emoji_code: string; rendered: string }>  // exported from MessageView.tsx
MessageView({
  message, own, realmUrl, ownUserId,
  edit,                    // { raw: string } | null — non-null renders the inline editor
  busy,                    // disables action buttons during API calls
  onStartEdit, onCancelEdit,
  onSaveEdit(content: string),
  onDelete(),
  onToggleReaction(r: { emoji_name: string; emoji_code: string; reaction_type: string }),
})
ThreadView({
  messages, hasThread, noPage,
  threadKey,               // string | null — scroll resets when this changes (backlog #6)
  ownEmail, ownUserId, realmUrl,
  editState,               // { id: number; raw: string } | null
  busy,
  onStartEdit(id: number), onCancelEdit(), onSaveEdit(id: number, content: string), onDelete(id: number),
  onToggleReaction(id: number, r: { emoji_name: string; emoji_code: string; reaction_type: string }),
  onRendered(ids: number[]),   // read-marker feed
})
```

- [ ] **Step 1: Write the failing tests**

`src/panel/MessageView.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, test, vi } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { MessageView } from './MessageView'

const REALM = 'https://zulip.example.com'

function msg(over: Partial<ZulipMessage> = {}): ZulipMessage {
  return {
    id: 1,
    sender_full_name: 'Ada',
    sender_email: 'ada@x.com',
    content: '<p>hello <strong>world</strong></p>',
    timestamp: 1700000000,
    subject: 'T · k',
    ...over,
  }
}

const noop = () => {}
function renderMsg(over: Partial<Parameters<typeof MessageView>[0]> = {}) {
  return render(
    <MessageView
      message={msg()}
      own={false}
      realmUrl={REALM}
      ownUserId={17}
      edit={null}
      busy={false}
      onStartEdit={noop}
      onCancelEdit={noop}
      onSaveEdit={noop}
      onDelete={noop}
      onToggleReaction={noop}
      {...over}
    />
  )
}

describe('MessageView', () => {
  test('renders sanitized Zulip HTML', () => {
    const { container } = renderMsg({ message: msg({ content: '<p>hi <strong>x</strong><script>bad()</script></p>' }) })
    expect(container.querySelector('strong')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
  })

  test('image placeholder swaps to img only on click', () => {
    const { container } = renderMsg({
      message: msg({ content: '<p><img src="https://cdn.x.com/a.png"></p>' }),
    })
    expect(container.querySelector('img')).toBeNull()
    const btn = container.querySelector('button.img-placeholder') as HTMLButtonElement
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.src).toBe('https://cdn.x.com/a.png')
  })

  test('edit/delete actions only on own messages', () => {
    const { container: other } = renderMsg({ own: false })
    expect(other.querySelector('.msg-actions')).toBeNull()
    const { container: mine } = renderMsg({ own: true })
    expect(mine.querySelector('.msg-actions')).toBeTruthy()
  })

  test('delete requires a second confirming click', () => {
    const onDelete = vi.fn()
    renderMsg({ own: true, onDelete })
    fireEvent.click(screen.getByTitle('Delete'))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('Confirm delete'))
    expect(onDelete).toHaveBeenCalled()
  })

  test('reaction chips show counts, highlight own, and toggle', () => {
    const onToggleReaction = vi.fn()
    const reactions = [
      { emoji_name: '+1', emoji_code: '1f44d', reaction_type: 'unicode_emoji', user_id: 17 },
      { emoji_name: '+1', emoji_code: '1f44d', reaction_type: 'unicode_emoji', user_id: 8 },
    ]
    const { container } = renderMsg({ message: msg({ reactions }), onToggleReaction })
    const chip = container.querySelector('.reaction-chip') as HTMLButtonElement
    expect(chip.textContent).toContain('2')
    expect(chip.classList.contains('mine')).toBe(true)
    fireEvent.click(chip)
    expect(onToggleReaction).toHaveBeenCalledWith(
      expect.objectContaining({ emoji_code: '1f44d', reaction_type: 'unicode_emoji' })
    )
  })

  test('quick-reaction row opens from the + button', () => {
    const onToggleReaction = vi.fn()
    const { container } = renderMsg({ onToggleReaction })
    fireEvent.click(screen.getByTitle('Add reaction'))
    const first = container.querySelector('.quick-reactions button') as HTMLButtonElement
    fireEvent.click(first)
    expect(onToggleReaction).toHaveBeenCalled()
  })

  test('inline editor renders raw content, saves and cancels', () => {
    const onSaveEdit = vi.fn()
    const onCancelEdit = vi.fn()
    renderMsg({ own: true, edit: { raw: '**raw**' }, onSaveEdit, onCancelEdit })
    const box = screen.getByDisplayValue('**raw**') as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: 'changed' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onSaveEdit).toHaveBeenCalledWith('changed')
    fireEvent.click(screen.getByText('Cancel'))
    expect(onCancelEdit).toHaveBeenCalled()
  })
})
```

`src/panel/ThreadView.test.tsx` (replace entire file):

```tsx
// @vitest-environment happy-dom
import { render, screen } from '@testing-library/preact'
import { describe, expect, test, vi } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { ThreadView } from './ThreadView'

function msg(id: number, content: string): ZulipMessage {
  return {
    id,
    sender_full_name: 'Ada',
    sender_email: 'ada@x.com',
    content,
    timestamp: 1700000000,
    subject: 'T · k',
  }
}

const noop = () => {}
function renderThread(over: Partial<Parameters<typeof ThreadView>[0]> = {}) {
  return render(
    <ThreadView
      messages={[]}
      hasThread={false}
      noPage={false}
      threadKey={null}
      ownEmail="me@x.com"
      ownUserId={17}
      realmUrl="https://zulip.example.com"
      editState={null}
      busy={false}
      onStartEdit={noop}
      onCancelEdit={noop}
      onSaveEdit={noop}
      onDelete={noop}
      onToggleReaction={noop}
      onRendered={noop}
      {...over}
    />
  )
}

describe('ThreadView', () => {
  test('no-page and empty states', () => {
    renderThread({ noPage: true })
    expect(screen.getByText('Open a web page to see its discussion.')).toBeTruthy()
  })

  test('renders sanitized message content via MessageView', () => {
    const { container } = renderThread({
      messages: [msg(1, '<p>hi <em>there</em><script>x()</script></p>')],
      hasThread: true,
      threadKey: 'k1',
    })
    expect(container.querySelector('em')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
  })

  test('reports rendered message ids for read marking', () => {
    const onRendered = vi.fn()
    renderThread({ messages: [msg(1, '<p>a</p>'), msg(2, '<p>b</p>')], hasThread: true, threadKey: 'k1', onRendered })
    expect(onRendered).toHaveBeenCalledWith([1, 2])
  })

  test('own messages get actions, others do not', () => {
    const { container } = renderThread({
      messages: [msg(1, '<p>a</p>'), { ...msg(2, '<p>b</p>'), sender_email: 'me@x.com' }],
      hasThread: true,
      threadKey: 'k1',
    })
    expect(container.querySelectorAll('.msg-actions')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/panel/MessageView.test.tsx src/panel/ThreadView.test.tsx`
Expected: FAIL — MessageView missing; ThreadView props mismatch.

- [ ] **Step 3: Implement MessageView**

`src/panel/MessageView.tsx`:

```tsx
import { useState } from 'preact/hooks'
import type { ZulipMessage, ZulipReaction } from '../shared/zulipClient'
import { sanitizeMessageHtml } from './renderMessage'

export interface ReactionInput {
  emoji_name: string
  emoji_code: string
  reaction_type: string
}

export const QUICK_REACTIONS: Array<{ emoji_name: string; emoji_code: string; rendered: string }> = [
  { emoji_name: '+1', emoji_code: '1f44d', rendered: '👍' },
  { emoji_name: 'heart', emoji_code: '2764', rendered: '❤️' },
  { emoji_name: 'smile', emoji_code: '1f604', rendered: '😄' },
  { emoji_name: 'tada', emoji_code: '1f389', rendered: '🎉' },
  { emoji_name: 'cry', emoji_code: '1f622', rendered: '😢' },
  { emoji_name: 'eyes', emoji_code: '1f440', rendered: '👀' },
]

function emojiFromCode(code: string): string {
  try {
    return String.fromCodePoint(...code.split('-').map((c) => parseInt(c, 16)))
  } catch {
    return '❓'
  }
}

function groupReactions(reactions: ZulipReaction[] | undefined, ownUserId: number | null) {
  const groups = new Map<string, { reaction: ZulipReaction; count: number; mine: boolean }>()
  for (const r of reactions ?? []) {
    const key = `${r.reaction_type}:${r.emoji_code}`
    const g = groups.get(key) ?? { reaction: r, count: 0, mine: false }
    g.count++
    if (ownUserId !== null && r.user_id === ownUserId) g.mine = true
    groups.set(key, g)
  }
  return [...groups.values()]
}

export function MessageView({
  message,
  own,
  realmUrl,
  ownUserId,
  edit,
  busy,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onToggleReaction,
}: {
  message: ZulipMessage
  own: boolean
  realmUrl: string
  ownUserId: number | null
  edit: { raw: string } | null
  busy: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: (content: string) => void
  onDelete: () => void
  onToggleReaction: (r: ReactionInput) => void
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [picking, setPicking] = useState(false)
  const [editText, setEditText] = useState(edit?.raw ?? '')
  const [editKey, setEditKey] = useState<string | null>(null)

  // Reset local editor text when a (new) edit session starts.
  const currentEditKey = edit ? `${message.id}:${edit.raw}` : null
  if (currentEditKey !== editKey) {
    setEditKey(currentEditKey)
    setEditText(edit?.raw ?? '')
  }

  function onBodyClick(e: Event) {
    const target = (e.target as HTMLElement).closest?.('button.img-placeholder') as HTMLButtonElement | null
    if (!target) return
    const src = target.getAttribute('data-src')
    if (!src) return
    const img = target.ownerDocument.createElement('img')
    img.src = src
    img.className = 'loaded-image'
    target.replaceWith(img)
  }

  const groups = groupReactions(message.reactions, ownUserId)

  return (
    <li class="message">
      <div class="meta">
        <span class="sender">{message.sender_full_name}</span>
        <span class="time">{new Date(message.timestamp * 1000).toLocaleString()}</span>
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
    </li>
  )
}
```

- [ ] **Step 4: Implement ThreadView**

`src/panel/ThreadView.tsx` (replace entire file):

```tsx
import { useEffect, useRef } from 'preact/hooks'
import type { ZulipMessage } from '../shared/zulipClient'
import { MessageView, type ReactionInput } from './MessageView'
import { shouldStickToBottom } from './scroll'

export function ThreadView({
  messages,
  hasThread,
  noPage,
  threadKey,
  ownEmail,
  ownUserId,
  realmUrl,
  editState,
  busy,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onToggleReaction,
  onRendered,
}: {
  messages: ZulipMessage[]
  hasThread: boolean
  noPage: boolean
  threadKey: string | null
  ownEmail: string
  ownUserId: number | null
  realmUrl: string
  editState: { id: number; raw: string } | null
  busy: boolean
  onStartEdit: (id: number) => void
  onCancelEdit: () => void
  onSaveEdit: (id: number, content: string) => void
  onDelete: (id: number) => void
  onToggleReaction: (id: number, r: ReactionInput) => void
  onRendered: (ids: number[]) => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const prevKey = useRef<string | null>(null)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    // Thread switch (key changed) always jumps to bottom (backlog #6); live
    // appends only stick when the reader was already near the bottom.
    const keyChanged = threadKey !== prevKey.current
    prevKey.current = threadKey
    if (keyChanged || shouldStickToBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) {
      el.scrollTop = el.scrollHeight
    }
    if (messages.length) onRendered(messages.map((m) => m.id))
  }, [messages, threadKey])

  if (noPage) return <div class="empty">Open a web page to see its discussion.</div>
  if (!hasThread && messages.length === 0) {
    return <div class="empty">No discussion yet. Start one.</div>
  }
  return (
    <ul class="messages" ref={listRef}>
      {messages.map((m) => (
        <MessageView
          key={m.id}
          message={m}
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
    </ul>
  )
}
```

- [ ] **Step 5: Append styles**

Append to `src/panel/style.css`:

```css
.msg-actions { margin-left: auto; display: inline-flex; gap: 4px; }
.msg-actions button { border: none; background: none; cursor: pointer; opacity: 0.5; padding: 0 2px; }
.msg-actions button:hover { opacity: 1; }
.msg-actions .danger { color: #b3261e; opacity: 1; }
.msg-editor textarea { width: 100%; min-height: 60px; }
.msg-editor button { margin-right: 6px; }
.reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; align-items: center; }
.reaction-chip { border: 1px solid #ccc; border-radius: 10px; background: #f7f7f7; padding: 0 6px; cursor: pointer; font-size: 12px; }
.reaction-chip.mine { border-color: #1a73e8; background: #e8f0fe; }
.reaction-add { border: none; background: none; cursor: pointer; opacity: 0.4; }
.reaction-add:hover { opacity: 1; }
.quick-reactions button { border: none; background: none; cursor: pointer; font-size: 16px; }
.img-placeholder { border: 1px dashed #aaa; background: #fafafa; padding: 8px 12px; cursor: pointer; color: #555; }
.loaded-image { max-width: 100%; }
.zulip-rendered blockquote { border-left: 3px solid #ccc; margin: 4px 0; padding-left: 8px; color: #555; }
.zulip-rendered pre { background: #f5f5f5; padding: 6px; overflow-x: auto; }
.zulip-rendered code { background: #f5f5f5; font-family: ui-monospace, monospace; font-size: 12px; }
.zulip-rendered .user-mention { background: #e8f0fe; border-radius: 3px; padding: 0 2px; }
.zulip-rendered table { border-collapse: collapse; }
.zulip-rendered th, .zulip-rendered td { border: 1px solid #ddd; padding: 2px 6px; }
```

- [ ] **Step 6: Run to verify green (App still on old props → tsc breaks until Task 7; run only the component suites)**

Run: `npx vitest run src/panel/MessageView.test.tsx src/panel/ThreadView.test.tsx`
Expected: PASS (11 tests). NOTE: `npx tsc --noEmit` will fail on App.tsx's old ThreadView usage — expected mid-sequence; Task 7 restores it. Do NOT run the full build here.

- [ ] **Step 7: Commit**

```bash
git add src/panel/MessageView.tsx src/panel/MessageView.test.tsx src/panel/ThreadView.tsx src/panel/ThreadView.test.tsx src/panel/style.css
git commit -m "feat: MessageView with sanitized HTML, actions, reactions; keyed thread scroll"
```

---

### Task 7: App integration (edit/delete/reactions/read + backlog 1, 3, 7)

**Files:**
- Modify: `src/panel/App.tsx` (replace entire file)

**Interfaces:**
- Consumes: everything above, exactly as the Produces blocks define.

- [ ] **Step 1: Replace `src/panel/App.tsx`**

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
import type { ReactionInput } from './MessageView'
import { panelTarget, type PanelTargetState } from './panelTarget'
import { createReadMarker, type ReadMarker } from './readMarker'
import { SetupView } from './SetupView'
import { ThreadView } from './ThreadView'
import { threadReducer } from './threadState'

const drafts = new Drafts()
const settingsStore = createSettingsStore()
const credentialsStore = createCredentialsStore()

interface Thread {
  entity: PageEntity
  key: string
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
  const [credentials, setCredentials] = useState<Credentials | null | undefined>(undefined)
  const [fullName, setFullName] = useState<string | undefined>(undefined)
  const [ownUserId, setOwnUserId] = useState<number | null>(null)
  const [showAccount, setShowAccount] = useState(false)
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, dispatch] = useReducer(threadReducer, [])
  const [error, setError] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [sending, setSending] = useState(false)
  const [editState, setEditState] = useState<{ id: number; raw: string } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const threadRef = useRef<Thread | null>(null)
  threadRef.current = thread
  const targetRef = useRef<PanelTargetState>({ pinned: false, currentUri: null })
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const clientRef = useRef<ZulipClient | null>(null)
  const credsRef = useRef<Credentials | null>(null)
  const sendingRef = useRef(false) // synchronous double-send latch (backlog #3)
  const initGenRef = useRef(0) // per-init generation token (backlog #7)
  const readMarkerRef = useRef<ReadMarker | null>(null)

  function applyCredentials(c: Credentials | null) {
    credsRef.current = c
    clientRef.current = c ? new ZulipClient(c) : null
    readMarkerRef.current?.dispose()
    readMarkerRef.current = c
      ? createReadMarker({
          flush: (ids) => clientRef.current?.markRead(ids) ?? Promise.resolve(),
          isVisible: () => document.visibilityState === 'visible',
        })
      : null
    setCredentials(c)
    if (c && clientRef.current) {
      const client = clientRef.current
      client
        .getOwnUser()
        .then((u) => {
          if (clientRef.current === client) {
            setFullName(u.fullName)
            setOwnUserId(u.userId)
          }
        })
        .catch(() => {})
    } else {
      setFullName(undefined)
      setOwnUserId(null)
    }
  }

  function resetThreadState() {
    targetRef.current = { pinned: false, currentUri: null }
    setThread(null)
    dispatch({ type: 'history', messages: [] })
    setDraftText('')
    setPinned(false)
    setError(null)
    setEditState(null)
  }

  useEffect(() => {
    void credentialsStore.load().then(applyCredentials)
    // Backlog #1: a sign-out or account switch in ANY window updates this panel too.
    return credentialsStore.watch((c) => {
      resetThreadState()
      applyCredentials(c)
    })
  }, [])

  useEffect(() => {
    void settingsStore.load().then((s) => (settingsRef.current = s))
    return settingsStore.watch((s) => (settingsRef.current = s))
  }, [])

  async function completeSetup(c: Credentials) {
    await credentialsStore.save(c)
    // The credentialsStore.watch above fires for this same save and applies it;
    // apply directly too so the transition is immediate even if events lag.
    resetThreadState()
    applyCredentials(c)
    notifySwCredentialsChanged()
  }

  async function signOut() {
    await credentialsStore.clear()
    resetThreadState()
    setShowAccount(false)
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
      const generation = ++initGenRef.current
      setError(null)
      setThread(null)
      setEditState(null)
      dispatch({ type: 'history', messages: [] })
      setDraftText(drafts.get(entity.entityUri))
      initThread(entity).catch((e) => {
        // Backlog #7: only the LATEST init may surface failure / re-arm the reducer.
        if (generation !== initGenRef.current) return
        setError(errText(e))
        targetRef.current = panelTarget(
          targetRef.current,
          { type: 'initFailed', uri: entity.entityUri },
          settingsRef.current.onNonWebPage
        ).state
      })
    } else if (action === 'clear') {
      setThread(null)
      setEditState(null)
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
      } else if (msg.type === 'messageUpdated') {
        dispatch({ type: 'update', id: msg.messageId, content: msg.renderedContent })
      } else if (msg.type === 'messageDeleted') {
        dispatch({ type: 'remove', id: msg.messageId })
      } else if (msg.type === 'reactionChanged') {
        dispatch({ type: 'reaction', op: msg.op, id: msg.messageId, reaction: msg.reaction })
      } else if (msg.type === 'reconnected') {
        const t = threadRef.current
        if (t?.existingTopic) loadHistory(t.existingTopic, t.entity.entityUri).catch(() => {})
      }
    }

    function connect(isReconnect: boolean) {
      port = chrome.runtime.connect({ name: 'panel' })
      portRef.current = port
      port.onMessage.addListener(handleMessage)
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
        window.setTimeout(() => {
          if (!disposed) connect(true)
        }, 200)
      })
      const t = threadRef.current
      if (!isReconnect || !t) {
        port.postMessage({ type: 'getActiveEntity' } satisfies PanelToSw)
      } else if (t.existingTopic) {
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
    if (targetRef.current.currentUri !== entity.entityUri) return
    setThread({ entity, key, existingTopic })
    if (existingTopic) await loadHistory(existingTopic, entity.entityUri)
  }

  async function loadHistory(topic: string, forUri: string) {
    const client = clientRef.current
    const creds = credsRef.current
    if (!client || !creds) return
    const fetched = await client.getMessages(creds.channelName, topic)
    if (targetRef.current.currentUri !== forUri) return
    dispatch({ type: 'history', messages: fetched })
  }

  async function send(text: string) {
    const t = threadRef.current
    const client = clientRef.current
    const creds = credsRef.current
    if (!t || !client || !creds) return
    if (sendingRef.current) return // backlog #3: synchronous latch
    sendingRef.current = true
    setSending(true)
    setError(null)
    try {
      let topic = t.existingTopic
      if (!topic) {
        topic = topicName(t.entity.title, t.key)
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
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  async function startEdit(id: number) {
    const client = clientRef.current
    if (!client) return
    setActionBusy(true)
    try {
      const raw = await client.getRawMessage(id)
      setEditState({ id, raw })
    } catch (e) {
      setError(errText(e))
    } finally {
      setActionBusy(false)
    }
  }

  async function saveEdit(id: number, content: string) {
    const client = clientRef.current
    if (!client) return
    setActionBusy(true)
    try {
      await client.updateMessage(id, content)
      setEditState(null) // rendered update arrives via the update_message event
    } catch (e) {
      setError(errText(e))
    } finally {
      setActionBusy(false)
    }
  }

  async function deleteMessage(id: number) {
    const client = clientRef.current
    if (!client) return
    setActionBusy(true)
    try {
      await client.deleteMessage(id)
    } catch (e) {
      setError(errText(e))
    } finally {
      setActionBusy(false)
    }
  }

  async function toggleReaction(id: number, r: ReactionInput) {
    const client = clientRef.current
    if (!client || ownUserId === null) return
    const message = messages.find((m) => m.id === id)
    const mine = message?.reactions?.some(
      (x) => x.emoji_code === r.emoji_code && x.reaction_type === r.reaction_type && x.user_id === ownUserId
    )
    try {
      if (mine) await client.removeReaction(id, r.emoji_name)
      else await client.addReaction(id, r.emoji_name)
      // State updates arrive via the reaction event.
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
        <button class="pin" title="Account" onClick={() => setShowAccount(true)}>
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
      <ThreadView
        messages={messages}
        hasThread={!!thread?.existingTopic}
        noPage={!thread && !error}
        threadKey={thread?.key ?? null}
        ownEmail={credentials.email}
        ownUserId={ownUserId}
        realmUrl={credentials.realmUrl}
        editState={editState}
        busy={actionBusy}
        onStartEdit={(id) => void startEdit(id)}
        onCancelEdit={() => setEditState(null)}
        onSaveEdit={(id, content) => void saveEdit(id, content)}
        onDelete={(id) => void deleteMessage(id)}
        onToggleReaction={(id, r) => void toggleReaction(id, r)}
        onRendered={(ids) => readMarkerRef.current?.noteRendered(ids)}
      />
      <Composer
        value={draftText}
        onInput={onDraftInput}
        onSend={(text) => void send(text)}
        disabled={!thread}
        busy={sending}
      />
    </div>
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
```

- [ ] **Step 2: Verify everything**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all green (~160 tests; exact count reported by the suite).

- [ ] **Step 3: Commit**

```bash
git add src/panel/App.tsx
git commit -m "feat: wire edits, deletions, reactions, read markers; credentials watch, send latch, init tokens"
```

---

### Task 8: Docs, version 0.3.0, checklist

**Files:**
- Modify: `package.json`, `public/manifest.json`, `README.md`, `dev/zulip/README.md`

- [ ] **Step 1: Version + docs**

1. `package.json` + `public/manifest.json`: `"version": "0.3.0"`.
2. `dev/zulip/README.md` — append after the Zulip ≥ 9 note (backlog #8):

```markdown
> LDAP-backed realms report password auth as unavailable in the extension's
> probe even though a password-style form exists; sign in with the API-key
> flow (or `fetch_api_key`, which also works against LDAP backends).
```

3. `README.md` — after the M1b checklist add:

```markdown
## M1c acceptance checklist

- [ ] A message using Zulip markdown (bold, code block, quote, @-mention, emoji, link, image) renders faithfully; the image shows a "Load image" placeholder until clicked.
- [ ] Edit your own message → the change appears live in a second user's panel; delete → it disappears live.
- [ ] Actions (✎/🗑) appear only on your own messages.
- [ ] React via + and by clicking an existing chip; both directions appear live for the other user; your own reactions are highlighted.
- [ ] After viewing a thread in the panel, its unread count drops in the Zulip web app.
- [ ] Sign out in one browser window → a second window of the same profile drops to setup by itself.
- [ ] Rapid A→B→A tab switching produces no spurious error bar.
- [ ] Switching focus between two browser windows retargets the panel.
- [ ] Navigating a tab to chrome://settings while its thread is shown: panel holds (default) without stale re-pushes later.
```

- [ ] **Step 2: Verify and commit**

Run: `npm run build && npm test && npx tsc --noEmit` — all green.

```bash
git add package.json public/manifest.json README.md dev/zulip/README.md
git commit -m "docs: M1c acceptance checklist; LDAP note; version 0.3.0"
```

---

## Plan self-review notes

- **Spec coverage:** sanitizer + click-to-load (T1), client endpoints + apply_markdown + event types (T2), reducer update/remove/reaction (T3), read marker (T4), lifecycle extraction + SW events + backlog 4/5 (T5), MessageView/ThreadView + backlog 6 (T6), App wiring + backlog 1/3/7 (T7), docs/version + backlog 8 (T8). All eight backlog items placed; all five feature streams placed.
- **Type consistency:** `ReactionInput` (T6) consumed in T7; `ZulipReaction` server-field naming used across T2/T3/T5/T6; `createReadMarker` opts (T4) match T7's usage; lifecycle API (T5) matches SW wiring; `threadKey={thread?.key}` feeds backlog #6.
- **Deliberate mid-sequence red:** T6 leaves tsc broken (App on old ThreadView props) until T7 — flagged in T6 Step 6; reviewers of T6 must not run the full build gate.
- **Two amended existing tests** (T2 Step 1) are spec-mandated and named exactly; any other existing-test edit is a violation.

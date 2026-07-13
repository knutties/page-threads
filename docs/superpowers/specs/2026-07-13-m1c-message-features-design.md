# PageThreads M1c — Message Features + Backlog Sweep Design

**Date:** 2026-07-13
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §5 (content conventions), §7 (content security). Third of four M1 sub-projects (M1a ✓ → M1b ✓ → **M1c** → M1d rules/badge).

## Goal

Messages render as real Zulip content (sanitized), users can edit/delete their own messages and react, read state syncs to Zulip — plus all eight accumulated backlog fixes.

## Scope

In — features:
- Zulip-rendered HTML (`apply_markdown: true`) sanitized with DOMPurify (new dependency; the only one).
- Click-to-load images (no remote fetch until clicked), including realm-relative uploads/emoji.
- Edit/delete own messages (inline), live `update_message`/`delete_message` events for everyone.
- Reactions: chips with counts + toggle; fixed quick-set (👍 ❤️ 😄 🎉 😢 👀); live `reaction` events.
- Read markers: visible rendered messages batched to `POST /messages/flags` `flag=read` (debounced 2 s); groundwork for M1d's badge.

In — backlog sweep (all eight):
1. Panel-side `credentialsStore.watch` → `applyCredentials` (multi-window sign-out/sign-in coherence).
2. SW loop/credential wiring extracted to `background/lifecycle.ts` (injected client factory; unit-testable; `background/index.ts` becomes listeners-only).
3. `sendingRef` synchronous latch in `send()` (timing-independent double-send guard).
4. `chrome.windows.onFocusChanged` added to the active-entity push triggers.
5. `tabs.onUpdated` clears stale `tabEntities` entries when a tab navigates where content scripts can't run.
6. ThreadView scroll reset keyed on thread identity (topicKey), not message-count heuristics.
7. Per-init generation token in App (kills spurious error on rapid A→B→A switches).
8. Dev README note: LDAP realms report `passwordAuthEnabled=false`; `fetch_api_key` still works — point LDAP users at either flow.

Out (M1d / later): per-domain rules, unread badge UI, settings/options page, full emoji picker, mention autocomplete, quote-reply permalinks, offline cache.

## Design

### Rendering pipeline

- `zulipClient.getMessages` and the SW's `/register` switch to `apply_markdown: true`; `ZulipMessage.content` becomes Zulip-rendered HTML everywhere. Event and fetch paths stay consistent (both HTML).
- New `src/panel/renderMessage.ts`:
  - `sanitizeMessageHtml(html: string, realmUrl: string): string` — DOMPurify with a strict allowlist reflecting Zulip's renderer output: `p div span a strong em del code pre blockquote ol ul li br hr table thead tbody tr th td time sup sub details summary`; attributes limited per-tag (`a[href|title]`, `span[class]`, `time[datetime]`, `code/pre[class]`, `ol[start]`, `td/th[align]`). `a[href]` restricted to http(s) and realm-relative `#narrow` links (rewritten absolute against realmUrl); every `a` forced `target="_blank" rel="noopener noreferrer"`.
  - Images never pass through as `<img>`: a DOMPurify hook replaces each image with a `<button class="img-placeholder" data-src="…">` carrying the resolved absolute URL (realm-relative sources resolved against the stored realm). The component swaps placeholder → `<img>` on click only (§7 click-to-load; also covers Zulip emoji images and user uploads).
  - Output is injected via `dangerouslySetInnerHTML` ONLY after sanitization; `renderMessage.ts` is the single place HTML enters the DOM.
- Zulip-flavored CSS: `.user-mention`, blockquotes, code blocks (no highlight.js — plain monospace), tables, spoiler `details`.
- `splitLinks` no longer used for message bodies (server linkifies); retained for plain-text spots (header title etc.).

### Edit & delete

- Ownership = `message.sender_email === credentials.email` (realm-local, sufficient here).
- Hover/focus reveals ✎ and 🗑 on own messages.
- Edit: `getRawMessage(id)` (`GET /messages/{id}` with `apply_markdown: false`) → inline textarea replacing the body → save via `updateMessage(id, content)` (`PATCH /messages/{id}`), cancel restores. Busy/error handling mirrors the composer.
- Delete: inline confirm (two-click) → `deleteMessage(id)` (`DELETE /messages/{id}`).
- SW registers `update_message` + `delete_message` event types; new `SwToPanel` variants `{type:'messageUpdated', id, renderedContent}` and `{type:'messageDeleted', id}`; `threadReducer` gains `update` and `remove` actions (by id; unknown ids ignored). Server-side policy failures (edit window closed, no permission) surface via the existing error bar.

### Reactions

- `ZulipMessage` gains `reactions: Array<{ emojiName: string; emojiCode: string; reactionType: string; userId: number }>` (mapped from Zulip's shape); client methods `addReaction(id, emojiName)` / `removeReaction(id, emojiName)`.
- The panel needs own `user_id`: `getOwnUser` extends to return it (from `/users/me`).
- UI: chips under the message (`emoji ×n`, `.mine` highlight when own user reacted; click toggles); `+` opens the fixed quick-set row.
- SW registers `reaction` events → `{type:'reactionChanged', op:'add'|'remove', messageId, emojiName, emojiCode, reactionType, userId}` → reducer merges into the message's reactions (idempotent: add ignores duplicates, remove ignores absent).

### Read markers

- `src/panel/readMarker.ts`: `createReadMarker(flush: (ids: number[]) => Promise<void>, debounceMs = 2000)` — collects message ids, dedupes against everything already flushed, debounced flush; `noteRendered(ids)` called from ThreadView render effect only when `document.visibilityState === 'visible'`; visibilitychange listener flushes/starts collection accordingly.
- Client method `markRead(ids)` → `POST /messages/flags` (`messages`, `op:'add'`, `flag:'read'`). Failures are silently retried on the next flush (ids stay queued).

### Backlog sweep details

1. App: the thread/draft/pin resets currently inlined in `signOut` extract into `resetThreadState()`; a new mount effect `credentialsStore.watch((c) => { resetThreadState(); applyCredentials(c) })` makes a sign-out or account switch in any other window drop/rebuild this panel too (the credential-gated port effect already cycles the connection).
2. `src/background/lifecycle.ts`: `createLifecycle({ makeClient, makeLoop, store })` returning `{ onCredentials(c), onPortCountChanged(n), onCredentialsChanged(), stop() }` — owns `credentials`/`loop` state; `background/index.ts` wires chrome listeners to it. Unit tests cover: cold-start-with-port ordering, double restart, sign-out stop, no-creds no-loop.
3. `send()` adds `sendingRef` checked/set synchronously before any await (state `sending` stays for the UI).
4. SW: `chrome.windows.onFocusChanged.addListener((id) => { if (id !== chrome.windows.WINDOW_ID_NONE) void pushActiveEntity() })`.
5. SW: `chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading' && info.url && !/^https?:/.test(info.url)) { tabEntities.delete(tabId); void pushActiveEntity() } })`.
6. ThreadView receives `threadKey: string | null`; scroll-to-bottom fires when the key changes (or on first history), stick-to-bottom logic unchanged for appends.
7. App `initThread` stamps a generation (`initGen`); the catch only fires `initFailed`/error surface when its generation is still current.
8. Dev README LDAP paragraph.

## Testing

- Unit: `sanitizeMessageHtml` XSS corpus (script/style/iframe/event handlers/`javascript:`/`data:` hrefs/svg onload/forms) + allowlist positives (mention spans, code blocks, tables, `#narrow` rewrite); image-placeholder hook (absolute + realm-relative + emoji); `threadReducer` update/remove; reaction merge idempotency; `createReadMarker` (fake timers: debounce, dedupe, retry-on-failure, visibility gating via injected state); `lifecycle.ts` state machine; scroll-key change detection; sendingRef latch (double-call test through App-level helper if extractable, else Composer-level busy test stands).
- Component: own-message actions visibility; edit inline flow (fake api); reaction chip toggle; click-to-load placeholder swap.
- Manual checklist (README): formatting fidelity vs Zulip web; image click-to-load; edit/delete seen live by second user; reactions toggle both directions incl. live updates; unread counts drop in Zulip web after viewing in panel; two-window sign-out coherence; rapid A→B→A no spurious error; window-focus switch retargets panel.

## Acceptance

1. A message using Zulip markdown (bold, code block, quote, mention, emoji, link, image) renders faithfully and safely in the panel; the image loads only on click.
2. Edit and delete of own messages round-trip and appear live in a second user's panel; reactions toggle live both directions.
3. Reading a thread in the panel clears its unreads in Zulip web.
4. All eight backlog items verifiably fixed (unit tests where stated; manual items on the checklist).
5. Version 0.3.0; all existing 132 tests keep passing.

# PageThreads M0 — Walking Skeleton Design

**Date:** 2026-07-11
**Status:** Approved
**Parent spec:** [WHAT.md](../../../WHAT.md) (Draft v0.2). This document pins down decisions for milestone M0 only (WHAT.md §10.1). Where the two disagree, WHAT.md is the product spec and this is the M0 build contract.

## Goal

Prove the whole pipeline end-to-end: open a side panel on any web page, resolve the page to a Zulip topic, read the thread, post to it, and see other users' messages appear live — against a real Zulip server.

## Scope

In:
- Chrome-only Manifest V3 extension (no Firefox until M2).
- Fixed realm URL + hardcoded API key, supplied via a gitignored `src/config.ts` (checked-in `src/config.example.ts` template).
- Generic web resolver only, canonicalization steps 1–2 from WHAT.md §4.4: same-domain `<link rel="canonical">` else normalized `location.href` (lowercase scheme/host, strip default ports, strip trailing slash except root, strip fragment, remove tracking-param deny-list, sort remaining params). No per-domain overrides, no tool resolvers.
- Topic key + name per WHAT.md §4.6: `topicKey = base64url(sha256(entityUri))[:16]`, topic name `"<title ≤40 chars> · <topicKey>"`, header message on first post.
- Side panel: message list (last 50), composer, live updates via Zulip event long-poll.
- Message rendering: escaped plain text with linkified URLs. No Markdown, no DOMPurify (M1).

Out (explicitly deferred):
- Auth/onboarding flow, unread badge, read markers, edit/delete/reactions, SPA navigation handling, per-domain rules, strict privacy mode, offline cache, resolver versioning UI. (M1–M2 per WHAT.md §10.)

## Architecture

Three build entries from one Vite config into `dist/`; static `manifest.json` copied as-is.

### Content script (`src/content/`)
Runs at `document_idle` on `<all_urls>`. Calls the pure `canonicalize()` on `location.href` + the page's canonical link, sends `{entityUri, title}` to the service worker via `runtime.sendMessage` on load. No DOM writes, no other responsibilities in M0.

### Service worker (`src/background/`)
- Maintains `tabId → {entityUri, title}` map from content-script messages.
- Answers the panel's "what entity is the active tab on?" request.
- Owns the single Zulip event queue: `POST /register` (message events, narrowed to the configured channel), then a `GET /events` long-poll loop while at least one panel `Port` is connected. Stops polling when the last port disconnects.
- Fans received message events out to connected panel ports.
- Re-registers on `BAD_EVENT_QUEUE_ID` and retries transient long-poll failures with capped exponential backoff (1s → 30s).

### Side panel (`src/panel/`)
Preact + TypeScript single-view app.
1. On open: connect a `Port` to the SW, request the active tab's `{entityUri, title}`.
2. Compute topicKey/topic name; resolve the existing topic by `· <topicKey>` suffix via `GET /users/me/<channel_id>/topics`.
3. Topic exists → fetch last 50 messages (`GET /messages` narrowed to channel+topic) and render. Topic missing → empty state: "No discussion yet. Start one."
4. Composer posts via `POST /messages`. First post to a fresh topic sends the header message, then the user's message (WHAT.md §6.2; if the header send fails, retry once and proceed regardless).
5. Message events arriving over the port that match the current topic are appended.

The panel calls Zulip REST directly; only the event loop lives in the SW.

## Module layout

```
manifest.json               (static; permissions: sidePanel only,
                             host_permissions: realm origin + <all_urls>)
src/
  config.example.ts         realmUrl, email, apiKey, channelName — copy to config.ts
  shared/canonicalize.ts    pure: (href, canonicalHref|null) → canonical URL string
  shared/topic.ts           pure: entityUri → topicKey; (title, topicKey) → topic name
  shared/zulipClient.ts     typed fetch wrapper: register, getEvents, getMessages,
                            getTopics, getChannelId, sendMessage
  shared/messages.ts        types for runtime messages + port protocol
  content/index.ts
  background/index.ts
  panel/index.html
  panel/main.tsx            app root: state, port wiring
  panel/ThreadView.tsx      message list + empty state
  panel/Composer.tsx        textarea + send
```

`shared/*` must stay browser-API-free (pure or fetch-only) so Vitest tests run in Node without extension mocks.

## Data flow

```
page load → content script → canonicalize() → SW tab map
panel open → Port to SW → active tab entity → topicKey
          → zulipClient.getTopics() suffix match → getMessages() → render
compose   → sendMessage(header if new topic, then body)
SW long-poll → message event → all ports → panel appends if topic matches
```

## Error handling (M0-minimal)

- REST failures: dismissible error bar in the panel with the Zulip error `msg`; composer stays enabled for retry.
- Long-poll: capped exponential backoff on network errors; `BAD_EVENT_QUEUE_ID` → re-register and continue (panel re-fetches history on reconnect notification).
- Everything else in WHAT.md §8 (offline cache, rate-limit countdown, topic moves) deferred to M2.

## Testing

- **Unit (Vitest, TDD):** `canonicalize` (canonical-link acceptance/rejection cases, normalization table, tracking-param stripping, param sorting), `topic` (known-vector sha256/base64url, 40-char truncation, suffix format), `zulipClient` (mocked fetch: auth header, endpoint shapes, error propagation), SW event-loop state machine where extractable as pure functions.
- **Manual e2e:** local Zulip via `docker-zulip` compose; bootstrap steps documented in README (create org, create `#web-threads` channel, copy API key to `config.ts`). Acceptance: two Chrome profiles on the same URL see each other's messages without refresh; a page with `utm_*` junk lands in the same thread as the clean URL.

## Dev backend

`docker-zulip` compose file under `dev/zulip/` with a README covering first-run bootstrap. Test traffic never leaves the machine.

## Acceptance criteria

1. `npm run build` produces a loadable unpacked extension in `dist/`.
2. On an arbitrary page, opening the panel shows the empty state; posting creates the topic in Zulip with header message + body, topic name carries the `· <topicKey>` suffix.
3. A second profile on the same page (including with tracking params) resolves the same topic and sees new messages live.
4. All Vitest suites pass.

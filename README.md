# PageThreads

A Manifest V3 browser extension that attaches a **live discussion thread to any web
page**, backed by a [Zulip](https://zulip.com) realm. Open the side panel on any
page and you get a per-page conversation — keyed by the page's canonical identity,
so everyone discussing the same article/issue/doc lands in the same thread, even
across tracking params and URL noise.

**Zero server code beyond stock Zulip.** All page-identity resolution and
canonicalization happens client-side in the extension; Zulip is the only backend.
That keeps it deployable against any Zulip realm and keeps page URLs out of any
third-party service — the privacy story is the product.

> Status: **M2 substantive work complete, v0.8.4.** See [MILESTONES.md](MILESTONES.md)
> for milestone status and per-chunk acceptance checklists, and [WHAT.md](WHAT.md)
> for the full spec.

## Features

- **Follows the active tab** — the panel re-targets as you switch tabs and on SPA
  navigation; 📌 pin to keep a thread while you browse.
- **Stable per-page identity** — a generic web resolver canonicalizes the URL
  (accepts same-origin `rel=canonical`, strips tracking params, sorts query) plus
  user-editable **per-domain rules** (`keepParams`, `pathRewrite`) and a
  **block-list**. Threads key on `sha256(entityUri)[:16]`.
- **Live + offline** — long-poll event stream fans out to the panel; an **unread
  badge** on the toolbar icon; a **per-topic offline cache** shows the last-fetched
  messages when the realm is unreachable (composer blocked, still draftable).
- **Full message UX** — sanitized Zulip Markdown (single DOMPurify gate),
  edit/delete your own messages, emoji reactions, read-marker sync.
- **Onboarding** — in-panel sign-in via email+password (`fetch_api_key`) or an
  API-key paste; credentials in extension storage only, never in page contexts.
- **Options page** — appearance (System / Aubergine / Dark themes), strict-privacy
  mode (no realm request until you ask), and the resolver rules / block-list editor
  with JSON import/export.
- **Cross-browser ready** — all extension-API access goes through one `browser.*`
  seam (Chrome today; a small localized slice remains for a Firefox build).

## How it works

Three contexts, one Zulip realm:

- **Content script** resolves the page to an `entityUri` (e.g.
  `web:https://example.com/article`) and a resolver descriptor, and reports it.
- **Service worker** owns the Zulip event loop (register / long-poll `get_events`,
  re-register + backoff on failure), the per-tab unread badge, and credential
  lifecycle.
- **Side panel** (Preact) renders the thread, composes messages, and syncs read
  markers.

A page's thread is a Zulip **topic** named `"<title, ≤40 chars> · <16-char key>"` in
a single channel (default `#web-threads`); the extension resolves threads by the
`· <key>` suffix (titles can change, the key can't). The first post seeds a header
message recording the entity URI and resolver version — a durable, versioned
identity for the thread.

## Install & build

```bash
npm install
npm run build      # → dist/  (Chrome MV3 unpacked extension)
npm test           # Vitest unit + component tests
```

## Load in the browser

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`.
2. Open any `http(s)` page and click the PageThreads toolbar icon to open the side panel.

If your managed Chrome blocks unpacked extensions, use the bundled launcher —
Chrome for Testing with the extension pre-loaded:

```bash
dev/run-chrome.sh            # default profile
dev/run-chrome.sh user2      # second profile (e.g. a second Zulip user)
```

## First run

Open the panel on any page. PageThreads asks for your **Zulip realm URL**, then lets
you sign in with **email + password** (on realms with password auth) or by pasting
an **API key** (Zulip → Personal settings → Account & privacy → API key). The
channel (default `web-threads`) must already exist on the realm. Use the ⚙️ menu to
open settings or sign out.

## Development

**Backend:** a local Zulip via docker — see [dev/zulip/README.md](dev/zulip/README.md).
Test users and the `web-threads` channel are set up there.

**Reload rules (MV3 gotchas):**

> - **After every `npm run build`, reload the extension** (`chrome://extensions` →
>   ⟳). Relaunching the browser alone does not refresh the running service worker.
> - **After a `manifest.json` permission change, ⟳ is not enough** — fully quit and
>   relaunch (permission grants are fixed at browser launch).
> - **⟳ does not re-inject content scripts into already-open tabs, nor clear the
>   SW's in-memory caches.** Reload affected tabs, or do a full **Remove + Load
>   unpacked** for a clean state (a mismatched old content script + new panel can
>   produce stale/`undefined` data until reset).
> - A local realm uses a **self-signed cert** — open `https://127.0.0.1:9090` once
>   in the same browser and accept it, or every `fetch` fails with
>   `TypeError: Failed to fetch`.

**Workflow:** each change goes brainstorm → written **spec** → **plan** →
subagent-driven execution with per-task and whole-branch review → merge. Design docs
live in [`docs/superpowers/specs/`](docs/superpowers/specs/) and plans in
[`docs/superpowers/plans/`](docs/superpowers/plans/). Keep `renderMessage.ts` the
single HTML-injection gate, and API keys out of any page-visible context.

**Docs map:**

- [WHAT.md](WHAT.md) — the full specification (architecture, entity resolution,
  Zulip mapping, failure modes, milestones, Appendix A resolver table, Appendix B
  future knowledge-index constraints).
- [MILESTONES.md](MILESTONES.md) — milestone status + manual acceptance checklists.
- `docs/superpowers/` — per-chunk design specs and implementation plans.

## Tech stack

TypeScript (strict), Preact, Vite (multi-entry: panel / options / background /
content), Vitest + Testing Library, DOMPurify (sanitization), tldts
(registrable-domain matching). No backend beyond Zulip's REST + events API.

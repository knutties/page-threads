# PageThreads — Spec for a Universal Page-Discussion Browser Extension (Zulip backend)

**Status:** Draft v0.2 (v0.2: §4 rewritten around entity resolution; Appendix A added)
**Audience:** Implementers
**One-liner:** A Manifest V3 browser extension that attaches a live discussion thread to any web page, using a Zulip realm as the threading/chat backend, keyed by a resolved **entity URI** (canonical URL in the generic case; tool-aware entity identity for known SaaS tools).

---

## 1. Goals & Non-Goals

### Goals
- From any web page, open a panel showing the discussion thread for that page.
- Post, reply, edit, and react without leaving the page.
- Live updates (new messages appear without refresh).
- Deterministic mapping: any two users on the same page land in the same thread.
- Work within a single Zulip realm (team / community / self-hosted instance).
- Zero server code beyond stock Zulip. The extension talks to Zulip's REST + events API directly.

### Non-Goals (v1)
- Text-anchored annotations (Hypothesis-style selection anchoring). Threads are per-page.
- Public, open-to-anyone deployment (moderation model assumes a bounded realm).
- Federation across multiple Zulip realms.
- Mobile browsers.
- Offline composition / queueing.

---

## 2. High-Level Architecture

```
┌─────────────────────────────── Browser ───────────────────────────────┐
│                                                                        │
│  ┌──────────────┐   canonical URL    ┌──────────────────────────────┐  │
│  │ Content      │ ─────────────────▶ │ Side Panel (extension page)  │  │
│  │ Script       │   via runtime      │  - Thread UI (list/compose)  │  │
│  │ (per tab)    │   messaging        │  - Zulip client (REST + SSE- │  │
│  │  - canonical │ ◀───────────────── │    style long-poll events)   │  │
│  │    URL extr. │   unread badge     │                              │  │
│  └──────────────┘                    └───────────────┬──────────────┘  │
│                                                      │                 │
│  ┌───────────────────────────────┐                   │                 │
│  │ Service Worker (background)   │◀──────────────────┘                 │
│  │  - event queue owner          │        HTTPS                        │
│  │  - session/token storage      │          │                          │
│  │  - badge + notification mgmt  │          ▼                          │
│  └───────────────────────────────┘   ┌─────────────┐                   │
│                                      │ Zulip realm │                   │
└──────────────────────────────────────│  (server)   │───────────────────┘
                                       └─────────────┘
```

**Key decision: side panel, not injected iframe.** Chrome's `sidePanel` API (and Firefox's `sidebar_action`) avoids host-page CSP conflicts, frame-busting, z-index wars, and layout breakage. The content script's only jobs are (a) entity resolution (§4) — which for most pages is canonical-URL extraction, and for known tools may read page metadata — and (b) optional page-level affordances (badge count on the extension icon via the service worker).

---

## 3. Components

### 3.1 Content Script
- Runs at `document_idle` on `<all_urls>` (user can restrict via extension site-access settings).
- Runs the **entity resolver** (§4) for the current page; sends `{ entityUri, kind, displayName, representativeUrl, title, favicon, resolverId, resolverVersion }` to the service worker on load and on SPA navigation.
- Only the resolver matching the page's domain executes (domain-scoped dispatch); the generic web resolver is the universal fallback. Tier-2 resolvers (§4.3) may read specific DOM metadata (`link[rel=canonical]`, `og:url`, JSON-LD, tool-specific markers) — read-only.
- SPA navigation detection: listen to `popstate`, monkey-patch-free detection via `navigation` API where available, else a `MutationObserver` on `<title>` + periodic `location.href` diff (500ms, cheap). Re-resolution runs on every detected navigation; tools like Jira change the selected entity without a full navigation, so Tier-2 resolvers may additionally register a narrow `MutationObserver` on their known selection markers.
- **No UI injection.** No DOM writes to the host page.

### 3.2 Service Worker (background)
- Holds the Zulip session (API key) in `chrome.storage.session` (memory-backed) with an encrypted-at-rest copy in `chrome.storage.local` (see §7).
- Owns a single Zulip **event queue** per browser session (`register` once; `get_events` long-poll loop). Fans events out to open side panels via `runtime.Port`.
- Maintains a `tabId → entityUri` map; computes unread counts per entity and sets the toolbar badge per-tab (`action.setBadgeText({tabId})`).
- MV3 service workers are killed when idle; the long-poll keeps it alive while a panel is open. When no panel is open, drop to a lightweight `chrome.alarms`-driven poll (e.g. every 2 min, `GET /messages` with `narrow` on the active tab's topic) for badge freshness. Accept staleness here; it's just a badge.

### 3.3 Side Panel
- Extension-origin page (`side_panel.default_path`), opened via toolbar click or keyboard shortcut.
- Subscribes to the service worker via a `Port`; receives the active tab's canonical URL and the event stream.
- Renders the thread, composer, reactions, edit/delete (own messages), and a "open in Zulip" deep link.
- Stack suggestion: Preact or Svelte + no router; single-view app. Keep the bundle < 200 KB.

---

## 4. Entity Resolution

This is the correctness-critical piece. Two users looking at "the same thing" must map to the same topic. For most of the web, "the same thing" is a canonical URL. For SaaS tools (Jira, Google Drive, GitHub, …), the URL is only one of several *views onto an entity* — issue, document, pull request — and the entity, not any particular URL, is the discussion object. So the identity layer is a **resolver pipeline** producing an **entity URI**, with URL canonicalization as the generic fallback resolver.

### 4.1 Resolver contract

```
resolve(url, pageContext) → { entityUri, kind, displayName, representativeUrl } | null
```

- `entityUri` — the durable identity string (grammar in §4.2). Everything downstream hashes this.
- `kind` — e.g. `jira.issue`, `gdrive.doc`, `github.pr`, `web.page`. Reserved for UI affordances and analytics; not part of the key.
- `displayName` — human-readable name for the topic title (e.g. `PROJ-123: Fix mandate retry loop`), preferred over `document.title` when available.
- `representativeUrl` — a clean, shareable URL recorded in the header message (e.g. the `/browse/PROJ-123` form).
- `pageContext` — read-only access to page metadata for Tier-2 resolvers (see §4.3).
- Resolvers are **domain-scoped**: dispatch selects at most one tool resolver by registrable domain (plus wildcard patterns for `*.atlassian.net`-style tenancy); if it returns `null` or no tool resolver matches, the generic web resolver runs. Exactly one resolver's output wins.

### 4.2 Entity URI grammar

```
entity-uri = scheme ":" authority "/" entity-path
scheme     = resolver id ("jira" | "gdrive" | "github" | "confluence" | "web" | …)
authority  = tenant/instance identifier (host for tenant-scoped tools; omitted where global)
entity-path= tool-specific stable identity

Examples:
  jira:acme.atlassian.net/issue/PROJ-123
  gdrive:doc/1x8QwErTy…                     (fileId; type-prefixed)
  github:pr/juspay/hyperswitch/4521
  github:repo/juspay/superposition
  confluence:acme.atlassian.net/page/98311
  web:https://example.com/article            (generic fallback; payload is canonical URL C)
```

Rules: the URI must be **stable under renames** (IDs, not slugs/titles, wherever the tool distinguishes them), **case-normalized** per the tool's own case-sensitivity semantics, and **minimal** (no view state, no query params, no tabs/sub-views unless the granularity policy in Appendix A says the sub-view is the entity).

### 4.3 Resolver tiers

| Tier | Inputs | Examples | Notes |
|---|---|---|---|
| 1 — URL-pattern | URL only; declarative regex/URLPattern rules | `github.com/:o/:r/pull/:n` → `github:pr/:o/:r/:n`; Jira `/browse/KEY-123` | Expressible in the JSON ruleset; user-extensible |
| 2 — DOM-assisted | URL + page metadata (`rel=canonical`, `og:url`, JSON-LD, tool-specific DOM markers) | Jira board with `?selectedIssue=` absent from URL; Drive doc title; SPA state not reflected in URL | Ships as code with the extension, versioned; read-only DOM access |
| 3 — API-assisted | Requires authenticated calls to the target tool | Resolving Drive *shortcut* files to their target fileId | **Out of scope for v1.** Consequence: a shortcut and its target are distinct entities; documented limitation |

### 4.4 Generic web resolver (fallback; formerly the whole of §4)

1. If `<link rel="canonical" href>` exists, is same-registrable-domain as `location`, and is an absolute `http(s)` URL → use it. (Reject cross-domain canonicals: a syndicated article pointing at the original publisher would silently move your team's discussion.)
2. Else start from `location.href` and normalize:
   - Lowercase scheme and host; strip default ports; strip trailing slash on path (except root); strip fragment.
   - Remove known tracking params (deny-list): `utm_*`, `gclid`, `fbclid`, `mc_cid`, `mc_eid`, `igshid`, `ref`, `ref_src`, `_hsenc`, `_hsmi`, `vero_*`, `yclid`, `msclkid`.
   - Sort remaining query params lexicographically.
3. Apply **per-domain overrides** from a user-editable JSON ruleset stored in `storage.sync` (these are effectively user-authored Tier-1 rules), e.g.:

```json
{
  "news.ycombinator.com": { "keepParams": ["id"] },
  "youtube.com":          { "keepParams": ["v"], "pathRewrite": "/watch" }
}
```

4. Result: `entityUri = "web:" + C` where `C` is the canonical URL string.

### 4.5 Versioning

- Every resolver (built-in or ruleset-derived) carries a `resolverId` + integer `resolverVersion`; both are recorded in the header message.
- Granularity-policy changes (Appendix A) or rule edits that would re-key existing threads bump the version. On mismatch between the live resolver's output and a previously seen key for the same page, the panel resolves **both** URIs and offers the old thread as a read-only "earlier discussion" merge view (mechanism shared with §8).

### 4.6 Topic key
- `topicKey = base64url( sha256(entityUri) )[:16]` — 16 chars keeps topics short and clear of Zulip's 60-char topic length limit regardless of URI length.
- **Topic name** = `"<displayName (else page title), truncated to 40 chars> · <topicKey>"`. Human-readable in Zulip's own UI, machine-resolvable by suffix. The extension resolves threads by matching the `· <topicKey>` suffix, never the title (titles change).
- First message posted to a new topic is a **header message** sent by the extension on the user's behalf:

  > 🔗 Discussion for: `<displayName>`
  > Entity: `<entityUri>` (resolver `<resolverId>@<resolverVersion>`)
  > Link: `<representativeUrl>`
  > Started by @user

  This makes topics navigable from inside Zulip proper and gives the identity + a working link a durable home (the topic name only holds the hash).

---

## 5. Zulip Data Model & API Mapping

### Channel layout
- One dedicated channel (stream), e.g. `#web-threads`, created by an admin; all page discussions are **topics** within it.
- Rationale: Zulip's topic model is exactly "many small threads inside one container." One channel keeps subscription management trivial (everyone in the program subscribes once) and keeps the realm's channel list clean.
- Optional v1.1: shard by registrable domain (`#web/github.com` style) if a single channel's topic volume becomes unwieldy. Keep the topicKey scheme identical so migration is a message move.

### API usage
| Action | Endpoint |
|---|---|
| Auth (initial) | `POST /api/v1/fetch_api_key` (username+password) or manual API-key paste; realms with SSO use the panel's "log in via browser" flow → `GET /accounts/…` then API-key retrieval from settings (documented onboarding step) |
| Register event queue | `POST /api/v1/register` with `event_types=["message","update_message","delete_message","reaction"]`, `narrow=[["channel","web-threads"]]` |
| Long-poll events | `GET /api/v1/events?queue_id=…&last_event_id=…` |
| Fetch thread history | `GET /api/v1/messages` with `narrow=[["channel","web-threads"],["topic","<name>"]]`, `anchor=newest`, `num_before=50` |
| Resolve topic by key | `GET /api/v1/users/me/<channel_id>/topics`, filter suffix `· <topicKey>` (cache aggressively) |
| Post message | `POST /api/v1/messages` `type=stream, to=web-threads, topic=<name>` |
| Edit / delete own | `PATCH /api/v1/messages/<id>` / `DELETE …` |
| Reactions | `POST/DELETE /api/v1/messages/<id>/reactions` |
| Mark read | `POST /api/v1/messages/flags` `flag=read` |

### Message content conventions
- Standard Zulip Markdown; render with a CommonMark renderer + Zulip's emoji/`@`-mention syntax. v1 may render mentions as plain styled text (no autocomplete).
- Replies are flat within the topic (Zulip topics are flat); quote-reply uses Zulip's `> ` quote convention with a `#narrow` permalink.

---

## 6. Core Flows

### 6.1 Open panel on a page
1. Toolbar click → `sidePanel.open()` for the tab.
2. Panel asks SW for the tab's `{entityUri, topicKey, displayName}`.
3. Panel checks topic-resolution cache → else `get_stream_topics`, suffix-match.
4. **Topic exists:** fetch last 50 messages, render, mark visible messages read on scroll-into-view.
   **Topic doesn't exist:** render empty state — "No discussion yet. Start one." Nothing is created server-side until the first post (avoid topic litter).
5. SW event loop pushes new events narrowed to this topic; panel appends.

### 6.2 First post on a page
1. User writes message, hits send.
2. Panel posts the **header message** (§4) then the user's message, both to the derived topic name. (Two sends; if the header send fails but the user message succeeds, retry header once and otherwise proceed — the topicKey suffix still makes the thread resolvable.)

### 6.3 SPA navigation
1. Content script detects URL/selection change → re-run resolver → notify SW if `entityUri` changed.
2. If panel is open and pinned to "follow active tab" (default), panel swaps to the new topic. A pin toggle lets the user freeze the panel on a thread while navigating.

### 6.4 Unread badge
- SW keeps per-topicKey unread counts from the event stream (messages not sent by self, not marked read).
- Badge on the toolbar icon per tab = unread count for that tab's topic; `•` if a thread exists with no unreads; empty if no thread.

---

## 7. Auth, Security, Privacy

- **Credential storage:** API key in `chrome.storage.session` for runtime use. Persistent copy in `chrome.storage.local` encrypted with a key held in `storage.session`… is circular; pragmatically: store API key in `storage.local` (extension storage is per-profile and not page-accessible), never in cookies or page-visible contexts. Document that anyone with profile access has the key (same threat model as Zulip's own web app cookies).
- **Realm allow-list:** the extension is configured with exactly one Zulip realm URL; all requests are hard-pinned to it. `host_permissions` limited to the realm origin plus `<all_urls>` for the content script (or narrower, per user's site-access choice).
- **Privacy defaults:**
  - No URL leaves the browser except when the user opens the panel (topic resolution) or posts. Passive browsing sends nothing.
  - Optional strict mode: don't even resolve topics until the panel is opened *and* the user clicks "check for discussion."
  - Per-domain block-list (banking, health, intranet patterns pre-seeded) where the content script does not run.
- **Content security:** panel renders Markdown → sanitize rendered HTML (DOMPurify), no remote images by default (click-to-load), all links `rel="noopener noreferrer"` opening in new tabs.
- **Zulip-side authz:** channel permissions govern everything (who can post, edit windows, moderators). The extension adds no auth layer of its own.

---

## 8. Failure Modes & Handling

| Failure | Handling |
|---|---|
| Event queue expired (`BAD_EVENT_QUEUE_ID`) | Re-`register`, re-fetch active topic history, diff-merge by message ID |
| SW killed mid-session | Panel `Port` disconnect → panel triggers SW wake, SW re-registers queue |
| Topic renamed in Zulip UI (title part) | Resolution is by `· <topicKey>` suffix — unaffected. If suffix itself is edited, thread is orphaned; header message's URL allows manual recovery |
| Topic moved to another channel | v1: treat as not found; header message findable via search. v1.1: search fallback across channels |
| Resolver drift (rule/policy update changes `entityUri`) | Resolver versioning (§4.5); resolve both old and new topicKey, offer "merge view" read-only of the old thread |
| Wrong-granularity resolution (e.g. board resolved instead of selected issue) | Panel shows resolved `displayName` + kind prominently; "discuss the page instead" affordance falls back to the generic web resolver for this view |
| Rate limits (429) | Exponential backoff; composer disabled with countdown |
| Offline | Panel shows cached last-fetched messages (per-topic LRU cache in `storage.local`, ~50 topics), composer disabled |

---

## 9. Settings Surface

- Realm URL (fixed after setup; changing it resets state).
- Site access mode: all sites / on click / allow-list.
- Domain block-list, Tier-1 resolver rules / canonicalization overrides (JSON editor + import/export via `storage.sync`), and per-tool-resolver enable/disable toggles.
- Follow-active-tab vs. pinned panel default.
- Strict privacy mode toggle.
- Notification preferences (badge only / browser notifications for replies to you).

---

## 10. Milestones

1. **M0 — Walking skeleton (1–2 days):** fixed realm + hardcoded API key; canonicalization (steps 1–2 only); open panel, resolve/fetch/post to topic; long-poll events; no badge.
2. **M1 — Usable (1 week):** onboarding/auth flow, per-domain rules, SPA nav handling, unread badge, read markers, edit/delete/reactions, sanitized Markdown.
3. **M2 — Robust (1 week):** queue-recovery, offline cache, rule versioning/migration, strict privacy mode, Firefox port (`sidebar_action`, `browser.*` polyfill).
4. **M3 — Nice-to-have:** mention autocomplete, quote-reply with permalinks, domain sharding, per-tab presence ("2 others viewing this page" via Zulip presence + a lightweight typing-status convention).

---

## 11. Open Questions

1. **Title in topic name vs. pure hash:** titles make Zulip-native browsing pleasant but mean the first poster's page title wins forever (or requires a rename bot). Acceptable? Alternative: hash-only topics + rely on header message, at the cost of ugly topic lists.
2. **Who creates the header message when two users post near-simultaneously to a fresh topic?** Race is benign (two headers) — dedupe by convention (ignore duplicate headers in the panel renderer) or accept it?
3. **Should passive topic-existence checks be batched/proxied** to avoid an N-requests-per-browsing-session pattern against the realm, or is `get_stream_topics` caching (channel-wide, one call, TTL 60s) sufficient? Likely sufficient for realm-sized user bases.
4. **Firefox MV3 event-page differences** — long-poll ownership may need to live in the panel on Firefox; verify before M2.
5. **Granularity defaults** (Appendix A): is "PR = one entity, all sub-views unified" right, or do teams want per-file review threads? Is a Jira *board* ever a useful discussion object, or should boards always defer to the selected issue / fall back to `web:`?
6. **Dual-entity views**: a board with a selected issue is legitimately *two* entities on screen. v1 resolves to the selected issue only; should the panel eventually offer a switcher between all entities the resolvers detected on the page?
7. **Tier-2 resolver maintenance cost**: tool DOMs churn. Do we pin resolvers to detectable app-version markers and fail closed to `web:` fallback, or fail open with a "resolver may be stale" banner?

---

## Appendix A — Initial Resolver Table

Granularity policy = which on-screen thing is *the entity*. These are product decisions, made explicit here so changing them is a conscious, versioned act (§4.5). All resolvers below ship built-in; Tier per §4.3.

### A.1 Jira (`jira:` — matches `*.atlassian.net`, plus user-configured self-hosted hosts)

| View | Resolution | Tier |
|---|---|---|
| `/browse/KEY-123` | `jira:<host>/issue/KEY-123` | 1 |
| Board/backlog with `?selectedIssue=KEY-123` | `jira:<host>/issue/KEY-123` — **the selected issue wins over the board** | 1 |
| Board/backlog, nothing selected | `jira:<host>/board/<boardId>` | 1 |
| Issue selected via click without URL change | Read selected-issue marker from DOM | 2 |
| Project pages, dashboards, JQL search results | Fall back to `web:` (generic) — transient views, not durable entities | — |

Normalization: issue keys uppercased; host lowercased. Rename-safety: issue keys survive summary edits but **change on project move** — accepted limitation (old thread reachable via merge-view once someone opens the new key's empty thread; the old header message remains searchable).

### A.2 Google Drive / Docs / Sheets / Slides (`gdrive:`)

| View | Resolution | Tier |
|---|---|---|
| `docs.google.com/document/d/<id>/(edit|view|preview…)` | `gdrive:doc/<id>` | 1 |
| `…/spreadsheets/d/<id>/…` (any `gid`) | `gdrive:sheet/<id>` — **whole spreadsheet, not per-tab** | 1 |
| `…/presentation/d/<id>/…` (any slide) | `gdrive:slides/<id>` | 1 |
| `drive.google.com/open?id=<id>`, `/file/d/<id>/…` | `gdrive:file/<id>` | 1 |
| Drive folder `…/folders/<id>` | `gdrive:folder/<id>` | 1 |
| Shortcut files | Resolve as the **shortcut's own** fileId (target resolution is Tier 3, out of scope v1) | 1 |
| Docs tabs (`?tab=`) / headings (`#heading=`) | Ignored — doc-level granularity | 1 |

Normalization: fileIds are case-sensitive; preserve verbatim. Type prefix (`doc/sheet/slides/file/folder`) is derived from the URL path, letting the panel show the right icon/affordance while keeping one entity per fileId per type.

### A.3 GitHub (`github:` — authority omitted for github.com; GHE hosts get `github:<host>/…`)

| View | Resolution | Tier |
|---|---|---|
| `/pull/123` + `/files`, `/commits`, `/checks`, review threads | `github:pr/<owner>/<repo>/123` — **all PR sub-views unify** | 1 |
| `/issues/123` | `github:issue/<owner>/<repo>/123` | 1 |
| `/discussions/123` | `github:discussion/<owner>/<repo>/123` | 1 |
| Repo root, `/tree/<ref>`, `/blob/<ref>/<path>` | `github:repo/<owner>/<repo>` — **ref/path collapse to the repo** (per-file threads deferred; see Open Q5) | 1 |
| `/commit/<sha>` | `github:commit/<owner>/<repo>/<sha[:12]>` | 1 |
| Releases, actions runs, wikis, gists, org/user pages | Fall back to `web:` | — |

Normalization: owner/repo lowercased (GitHub treats them case-insensitively); issue/PR numbers verbatim. Rename-safety: repo renames redirect on GitHub's side but **change the entityUri** — same accepted limitation and recovery path as Jira project moves.

### A.4 Confluence (`confluence:` — matches `*.atlassian.net/wiki`, self-hosted configurable)

| View | Resolution | Tier |
|---|---|---|
| `/wiki/spaces/<space>/pages/<pageId>/<slug>` | `confluence:<host>/page/<pageId>` — slug ignored (survives renames) | 1 |
| Page edit view | Same as view | 1 |
| Space overview | `confluence:<host>/space/<spaceKey>` | 1 |

### A.5 Generic web (`web:`) — §4.4. Always last; never returns `null`.

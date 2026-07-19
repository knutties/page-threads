# PageThreads — Milestones & Acceptance Checklists

The milestone **roadmap** is defined in [WHAT.md §10](WHAT.md). This file tracks
**status** and holds the per-chunk **manual acceptance checklists** (the browser +
Zulip behaviors that unit tests can't cover). Every chunk was built spec → plan →
subagent-driven execution → review → merge; design docs live under
[`docs/superpowers/specs/`](docs/superpowers/specs/).

## Status (main, v0.8.4)

| Milestone | Scope | State |
|---|---|---|
| **M0** | Walking skeleton: resolve/fetch/post, long-poll events | ✅ merged |
| **M1** | Usable: onboarding/auth, per-domain rules + block-list, SPA nav, unread badge, read markers, edit/delete/reactions, sanitized Markdown, options page, strict privacy | ✅ merged (M1a–M1d-3) |
| **Theme** | Slack-inspired Aubergine + Dark, tokenized; avatars, grouping, hover reaction toolbar (v0.7.0) | ✅ merged |
| **M2a** | Backlog sweep: SW/badge/read-marker correctness + options edit-races | ✅ merged (M2a-1, M2a-2) |
| **M2b** | Offline read cache (per-topic LRU, cache fallback, offline banner) | ✅ merged |
| **M2c** | Reconnect hardening (precise `onReconnect`, badge refresh on reconnect) | ✅ merged |
| **M2d** | Resolver versioning contract (`resolverId@resolverVersion` in the header) | ✅ merged |
| **M2e** | `browser.*` cross-browser API seam (Chrome-safe slice of the Firefox port) | ✅ merged |
| **M3** | Nice-to-have: mention autocomplete, quote-reply, domain sharding, presence | — future |

### Deferred (bound backlog)

- **Resolver drift + read-only "earlier discussion" merge view** (WHAT.md §4.5, part 2) — when a rule/granularity change re-keys a page, resolve both keys and show the old thread read-only. Build when a resolver version actually bumps or rule-edit orphaning proves a real problem.
- **Firefox platform slice** — Firefox manifest (`sidebar_action` + background event page), `sidePanel`→`sidebar_action` wiring, dual-build, long-poll ownership on an event page, and load-testing. The `browser.*` seam (M2e) already localizes this to essentially one file; it needs a confirmed Firefox test environment.

---

## Acceptance checklists

Run against the dev backend (see [dev/zulip/README.md](dev/zulip/README.md)). **Before any run:** `npm run build`, then **Remove + Load unpacked `dist/`** in the browser (a plain ⟳ reload does not clear already-injected content scripts or the service-worker cache), and accept the realm's self-signed cert once. The extension card should show the current version.

### M0 — Walking skeleton

- [ ] `npm run build` produces a loadable unpacked extension in `dist/`.
- [ ] On a fresh page, the panel shows "No discussion yet. Start one."
- [ ] Posting creates the topic in Zulip (`#web-threads`) with a 🔗 header message followed by the posted message; the topic name ends in `· <16-char key>`.
- [ ] Opening the same URL **with `?utm_source=x&gclid=y` appended** resolves the same thread and shows the same messages.
- [ ] A message posted from the Zulip web UI into the topic appears in the open panel without a refresh (long-poll fan-out).
- [ ] A second Chrome profile (second Zulip user) on the same page sees new messages live.
- [ ] REST failures (e.g. stop the Zulip container, then send) show the dismissible error bar, and sending works again after the container is back.

### M1a — Live panel UX

- [ ] Switching tabs updates the panel to the new tab's thread without reopening.
- [ ] In-page SPA navigation (e.g. clicking between YouTube videos) re-resolves within ~1 s.
- [ ] 📌 Pin keeps the current thread while switching tabs; unpin catches up to the active tab.
- [ ] Landing on a new-tab/chrome:// page keeps the last thread visible (default `onNonWebPage: 'hold'`).
- [ ] A half-typed message survives a tab round-trip and never leaks into another page's composer.
- [ ] While scrolled up reading history, an incoming message does NOT yank the view; at the bottom, it does scroll.
- [ ] Enter in a CJK IME composition does not send.
- [ ] When thread init fails (e.g. Zulip container stopped), the error bar shows Retry, and Retry recovers once the server is back.

### M1b — Auth & onboarding

- [ ] Fresh profile: onboard via email+password against the dev realm; reach a working thread view.
- [ ] Fresh profile: onboard via API-key paste.
- [ ] Wrong password shows Zulip's error; wrong API key shows the credentials error.
- [ ] Unreachable realm URL errors on the realm step; a self-signed-cert realm shows the accept-the-warning hint.
- [ ] Channel name that doesn't exist shows the "ask your admin" error; works after creating the channel.
- [ ] ⚙️ → Sign out returns to setup; signing in as a different user gets live updates for that account (post from the Zulip web UI to verify).
- [ ] Credentials survive a full browser restart.
- [ ] Second profile (`dev/run-chrome.sh user2`) onboards as the second user with the SAME `dist/` build.

### M1c — Message features

- [ ] A message using Zulip markdown (bold, code block, quote, @-mention, emoji, link, image) renders faithfully; the image shows a "Load image" placeholder until clicked.
- [ ] Edit your own message → the change appears live in a second user's panel; delete → it disappears live.
- [ ] Actions (✎/🗑) appear only on your own messages.
- [ ] React via the toolbar and by clicking an existing chip; both directions appear live for the other user; your own reactions are highlighted.
- [ ] After viewing a thread in the panel, its unread count drops in the Zulip web app.
- [ ] Sign out in one browser window → a second window of the same profile drops to setup by itself.
- [ ] Rapid A→B→A tab switching produces no spurious error bar.
- [ ] Switching focus between two browser windows retargets the panel.
- [ ] Deleting a message from the Zulip web UI removes it live in the panel.

### M1d-1 — Options page + hardening

- [ ] The options page opens from the panel's ⚙️ → Settings and from `chrome://extensions`.
- [ ] Both toggles reflect stored values and take effect in an open panel without reload.
- [ ] Strict privacy ON: a fresh page shows the title + "Check for discussion"; DevTools Network shows ZERO realm requests until clicked; clicking resolves.
- [ ] Strict privacy OFF: the panel auto-resolves.
- [ ] Toggling "keep the last thread on non-web pages" changes behavior on a chrome:// tab live.
- [ ] Moving a message to a different topic in the Zulip web UI removes it from the open thread.

### M1d-2 — Resolver rules + block-list

- [ ] Options → Canonicalization rules: add `news.ycombinator.com` keepParams `id`. An HN item URL with extra params and the clean `?id=…` URL resolve to the same thread.
- [ ] Add a `pathRewrite` rule (youtube.com → `/watch`, keepParams `v`) → a `/watch?v=…&list=…` URL keys on `/watch?v=…`.
- [ ] Block a domain → a page there shows the no-page state and DevTools shows no realm request. Unblock → resolution returns (blocking is prospective; an already-open thread stays until you navigate away).
- [ ] Export → JSON of the current ruleset; Import round-trips; malformed JSON shows an error and changes nothing.
- [ ] Rules sync across profiles (storage.sync).
- [ ] Adding a subdomain (e.g. `mail.example.com`) shows the "affects all of example.com" note (M2a-2).

### M1d-3 — Unread badge

- [ ] Background a threaded tab, post to its topic from the Zulip web UI → the toolbar badge shows the count within ~2 min (instantly if a panel is open).
- [ ] Open the panel and read → the badge drops to `•`.
- [ ] No discussion → no badge; blocked domain → no badge.
- [ ] Your own message posted from the panel does not increment the badge.
- [ ] Two tabs with different unread each show their own badge when active.
- [ ] Idle the service worker, then click the tab → the badge recomputes from Zulip (survives SW restart).
- [ ] Badge count caps at `99+`.

### M2a-1 — Badge / read-marker correctness

- [ ] **F2:** open thread A (let it render), switch to thread B **within ~2 s** → B's badge is not wrongly zeroed; A's drops to `•`.
- [ ] **F3 (cold start):** stop the service worker, activate a threaded tab → the count appears promptly (not blank-then-2min).
- [ ] **F4 (focus):** two windows; focus the one with a threaded active tab → its badge refreshes.
- [ ] **F5a (first post):** post the first message on a fresh page → that tab's badge shows `•` immediately.
- [ ] **Logout:** with badges on several tabs, log out → all badges clear at once.

### M2a-2 — Options edit-races & UX

- [ ] After a failed save shows the error banner, a later successful edit clears it.
- [ ] Type into a keepParams/pathRewrite field and switch tabs (without clicking away) → the edit persists.
- [ ] Two rapid edits where the first save fails settle to the true persisted state (no dropped later edit).

### M2b — Offline read cache

- [ ] Open a thread online (populates cache). Stop the realm, switch away and back / reopen → cached messages show with the offline banner; Send disabled; the textarea still accepts a draft.
- [ ] Restart the realm → on reconnect the thread refreshes with live data, the banner clears, and the draft can send.
- [ ] A thread never opened online, viewed offline → empty + offline banner.

### M2c — Reconnect hardening

- [ ] With the panel open on a threaded tab, let the event queue expire (idle >~10 min, or restart the realm) → on recovery the panel reloads **once** and the badge recomputes promptly; a sustained outage does not reload repeatedly.

### M2d — Resolver versioning header

- [ ] Post the **first** message on a brand-new page → the header message's `Entity:` line reads `(resolver web@1)` (check in Zulip web).

### Theme (Aubergine / Dark)

- [ ] Panel is Aubergine by default: eggplant header, `host · N messages` subtitle, rounded avatars, grouped same-sender messages, green Send.
- [ ] Hover a message → the reaction toolbar appears (😀 + ✎/🗑 on your own); no persistent `+` row; chips only where reactions exist.
- [ ] Options → Appearance = Dark → panel + options re-theme live; reload → persists; = System → follows the OS.

### M2e — Cross-browser seam

- [ ] No dedicated check — invisible on Chrome (`browser === chrome`). If the sections above pass, every API call routes through the seam correctly.

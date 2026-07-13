# PageThreads

A Manifest V3 browser extension that attaches a live discussion thread to any web
page, using a Zulip realm as the backend. Spec: [WHAT.md](WHAT.md). Current state:
**M1c** (live panel, in-panel onboarding, rendered messages with edit/delete/
reactions/read markers; see docs/superpowers/specs/).

## Build

```bash
npm install
npm run build
npm test
```

Backend for development: see [dev/zulip/README.md](dev/zulip/README.md).

## Load in Chrome

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.
2. Navigate to any http(s) page, click the PageThreads toolbar icon to open the
   side panel.

If your managed Chrome blocks unpacked extensions, use `dev/run-chrome.sh`
(Chrome for Testing with the extension pre-loaded; second profile: `dev/run-chrome.sh user2`).

## First run

Open the panel on any page: PageThreads asks for your Zulip realm URL, then
lets you sign in with email+password (realms with password auth) or paste an
API key (Zulip → Personal settings → Account & privacy → API key). The
channel (default `web-threads`) must already exist on the realm. Credentials
are stored in extension storage; use the ⚙️ menu to sign out.

> **After every `npm run build`, reload the extension** (chrome://extensions →
> ⟳ on the PageThreads card) or wipe the dev profile. Relaunching the browser
> alone does NOT refresh the MV3 service worker — extension pages load fresh
> from disk, but the old service worker keeps running, which can leave the
> panel working while live updates silently use stale code.
>
> **After a `manifest.json` permissions change, ⟳ is NOT enough either:**
> `--load-extension` fixes permission grants at browser launch, so a newly
> added permission stays ungranted (`chrome.storage` = undefined, etc.) until
> you fully quit and relaunch the browser. Also reload open tabs after any
> extension reload — their old content scripts are orphaned.

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

## M1a acceptance checklist

- [ ] Switching tabs updates the panel to the new tab's thread without reopening.
- [ ] In-page SPA navigation (e.g. clicking between YouTube videos) re-resolves within ~1 s.
- [ ] 📌 Pin keeps the current thread while switching tabs; unpin catches up to the active tab.
- [ ] Landing on a new-tab/chrome:// page keeps the last thread visible (default `onNonWebPage: 'hold'`).
- [ ] A half-typed message survives a tab round-trip and never leaks into another page's composer.
- [ ] While scrolled up reading history, an incoming message does NOT yank the view; at the bottom, it does scroll.
- [ ] Enter in a CJK IME composition does not send.
- [ ] When thread init fails (e.g. Zulip container stopped), the error bar shows Retry, and Retry recovers once the server is back.

## M1b acceptance checklist

- [ ] Fresh profile: onboard via email+password against the dev realm; reach a working thread view.
- [ ] Fresh profile: onboard via API-key paste.
- [ ] Wrong password shows Zulip's error; wrong API key shows the credentials error.
- [ ] Unreachable realm URL errors on the realm step; a self-signed-cert realm shows the accept-the-warning hint.
- [ ] Channel name that doesn't exist shows the "ask your admin" error; works after creating the channel.
- [ ] ⚙️ → Sign out returns to setup; signing in as a different user gets live updates for that account (post from the Zulip web UI to verify).
- [ ] Credentials survive a full browser restart.
- [ ] Second profile (`dev/run-chrome.sh user2`) onboards as the second user with the SAME dist/ build — dist-user2 is gone.

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
- [ ] Reactions from another user appear live (verifies reaction events carry all expected fields).
- [ ] Deleting a message from the Zulip web UI removes it live in the panel (verifies delete_message event shape on this Zulip version).

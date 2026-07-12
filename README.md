# PageThreads

A Manifest V3 browser extension that attaches a live discussion thread to any web
page, using a Zulip realm as the backend. Spec: [WHAT.md](WHAT.md). Current state:
**M0 walking skeleton** (see `docs/superpowers/specs/`).

## Build

```bash
npm install
cp src/config.example.ts src/config.ts   # (src/config.ts is gitignored) then fill in realm URL, email, API key
npm run build
npm test
```

Backend for development: see [dev/zulip/README.md](dev/zulip/README.md).

## Load in Chrome

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.
2. Navigate to any http(s) page, click the PageThreads toolbar icon to open the
   side panel.

If your managed Chrome blocks unpacked extensions, use `dev/run-chrome.sh`
(Chrome for Testing with the extension pre-loaded; second profile + second-user
build: `dev/run-chrome.sh user2 dist-user2`).

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

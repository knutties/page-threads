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

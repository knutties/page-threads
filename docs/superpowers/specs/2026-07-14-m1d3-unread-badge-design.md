# PageThreads M1d-3 — Unread Badge Design

**Date:** 2026-07-14
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §6.4 (unread badge), §3.2 (SW badge polling). Third and final M1d chunk (M1d-1 ✓ → M1d-2 ✓ → **M1d-3 unread badge**). **M1 completes at merge of this chunk.**

## Goal

Show per-tab unread counts for each page's discussion on the toolbar icon, kept fresh via live events when a panel is open and a lightweight poll when it isn't — with Zulip as the source of truth so the count self-corrects.

## Scope

In:
- Per-`topicKey` unread cache in `chrome.storage.session` (rebuildable; Zulip is authoritative).
- `ZulipClient.getUnreadCount(channel, topic)` via an `is:unread` narrow.
- Live increment on `message` events (skip own messages); zero on read-markers; recompute on `chrome.alarms` (~2 min) and `tabs.onActivated`.
- Per-tab badge (`chrome.action.setBadgeText({tabId})`): unread number / `•` (thread, 0 unread) / empty (no thread).
- `"alarms"` manifest permission.

Out (deferred): browser notifications for replies-to-you (§9 — M2/M3); live badge updates on *background* tabs (only the active tab is live; background tabs refresh when activated/polled); cross-browser-session durability (session cache clears on browser close — re-derived next session).

## Design

### Unread state (`src/shared/unread.ts`)

- `createUnreadStore(area?, changed?, areaName?): Store<UnreadMap>` on `chrome.storage.session` (default area/areaName `'session'`), key `unread`. `UnreadMap = Record<topicKey, number>`. Built on the existing generic `createStore` (serialized writes; chrome only as default args). `storage.session` needs no new permission (covered by `"storage"`); it survives SW restarts within a browser session and clears on browser close.
- Pure `unreadReducer(map, action)`:
  ```ts
  type UnreadAction =
    | { type: 'increment'; topicKey: string }
    | { type: 'set'; topicKey: string; count: number }
    | { type: 'zero'; topicKey: string }
  ```
  increment adds 1 (default 0); set overwrites; zero sets 0. Unknown-topic actions are well-defined (increment/set create; zero on absent → sets 0). Returns the same reference when nothing changes (zero on already-0-or-absent).

### Unread count query (`src/shared/zulipClient.ts`)

- `getUnreadCount(channel: string, topic: string): Promise<number>` — `GET /messages`, narrow `[{channel}, {topic}, {operator:'is', operand:'unread'}]`, `anchor:'newest'`, `num_before: 1000`, `num_after: 0`, `apply_markdown: false`; returns `data.messages.length`. (Per-topic unread is small; 1000 is a generous cap. The badge display caps separately.) Own sent messages are auto-marked-read by Zulip, so `is:unread` naturally excludes them — consistent with the event-path own-message skip.

### Badge rendering (`src/panel/badge.ts` — shared pure helper)

- `badgeText(unread: number, hasThread: boolean): string` (§6.4):
  - `unread > 0` → the number, capped: `unread > 99 ? '99+' : String(unread)`.
  - `unread === 0 && hasThread` → `'•'`.
  - `!hasThread` → `''` (no thread / no-page / blocked).

### Badge orchestration (`src/background/badgeManager.ts`)

Extracted, injectable (mirrors M1c `lifecycle.ts`) so the flow is testable without chrome:

```ts
createBadgeManager(deps: {
  getUnread(topicKey: string): number
  setUnread(topicKey: string, count: number): void
  zeroUnread(topicKey: string): void
  incrementUnread(topicKey: string): void
  computeCount(channel: string, topic: string): Promise<number>   // → getUnreadCount
  setBadge(tabId: number, text: string): void
  channelName(): string | null                                    // from credentials
}): {
  onMessageEvent(topicName: string, senderIsSelf: boolean): void  // increment (unless self) + refresh active
  onMarkedRead(topicKey: string): void                            // zero + refresh
  refreshTab(tabId: number, topicKey: string | null, topicName: string | null): Promise<void>  // recompute + set badge
}
```

`refreshTab`: if `topicKey`/`topicName` null (no thread / blocked / no-page) → `setBadge(tabId, '')`. Else → `count = await computeCount(channel, topicName)`; `setUnread(topicKey, count)`; `setBadge(tabId, badgeText(count, true))`. `onMessageEvent` increments the cache for the topic and re-sets the active tab's badge from cache (no network). `onMarkedRead` zeroes + re-sets.

### Service worker wiring (`src/background/index.ts`)

- Build the unread cache accessors over `createUnreadStore()` (async load/save; keep an in-memory mirror refreshed on `storage.onChanged` for the session area, same belt-and-braces pattern as credentials/lifecycle).
- `chrome.alarms.create('badge', { periodInMinutes: 2 })` + `chrome.alarms.onAlarm` → `refreshTab` for the active tab.
- `tabs.onActivated` → `refreshTab` for the newly-active tab (its `topicKey`/`topicName` from `tabEntities` + `topicKey()` derivation; a blocked/no-entity tab → clear badge).
- The event loop's `onEvent` `message` branch → `badgeManager.onMessageEvent(subject, sender===self)` in addition to the existing panel broadcast.
- New `RuntimeToSw` message `{type:'markedRead', topicKey}` (panel → SW) → `onMarkedRead`.
- `tabs.onRemoved` → `chrome.action.setBadgeText({ tabId, text: '' })` cleanup (best-effort).
- Badge needs the tab's topicName to query; the SW derives `topicKey` from the entity (`topicKey(entityUri)`) and needs the topic *name* too — resolve it the same way the panel does (getTopics suffix-match) or, cheaper, store the last-known topicName alongside the entity when the panel reports it. **Decision:** the panel already resolves the topic; when it does, it sends the SW `{type:'topicResolved', topicKey, topicName}` so the SW can badge without re-resolving. For a tab the panel never opened, the badge shows only after the first poll resolves it (acceptable staleness).

### Panel (`src/panel/App.tsx`)

- On a successful read-marker flush, send `{type:'markedRead', topicKey}` to the SW (the panel knows the current thread's `key`).
- On thread resolution (existing `initThread`), send `{type:'topicResolved', topicKey, topicName}` so the SW can badge that tab even before a poll.

### Manifest

- Add `"alarms"` to `permissions` (now `["sidePanel", "storage", "alarms"]`). `chrome.action` badge needs no permission. Docs note: permission add ⇒ full browser relaunch.

## Testing

- Unit: `unreadReducer` (increment new/existing, set overwrite, zero absent→0 and reference stability, zero already-0 returns same ref); `badgeText` (0+thread→`•`, N→`"N"`, 100→`"99+"`, no-thread→`''`); `getUnreadCount` (fake fetch: narrow includes `is:unread`+channel+topic, returns messages.length); `badgeManager` (onMessageEvent increments + skips self; onMarkedRead zeroes; refreshTab null→empty badge, resolved→computes+sets+caches); unread store round-trips on a fake session area.
- Component: none new (badge is SW-side; badgeText is covered by unit tests).
- Manual checklist: background a page's tab, post to its topic from Zulip web → badge shows the count within ~2 min; open the panel and read → badge drops to `•`; a page with no thread → no badge; a blocked domain → no badge; idle the SW (~1 min, DevTools shows it inactive) then activate the tab → badge recomputes (survives restart); switch between two tabs with different unread → each shows its own badge.

## Acceptance

1. An unread message in a tab's topic shows a count on the toolbar badge — live when a panel is open, within ~2 min via poll otherwise.
2. Reading the thread in the panel drops the badge to `•`; a tab with no discussion shows no badge; a blocked domain shows no badge.
3. The badge survives an SW restart (state re-derived from Zulip / session cache).
4. Own messages don't increment the badge.
5. Version 0.6.0; all existing 231 tests keep passing. **M1 is complete.**

# PageThreads M2b — Offline Read Cache

**Date:** 2026-07-18
**Status:** Approved (design presented and accepted in session)
**Parent spec:** [WHAT.md](../../../WHAT.md) §8 (Failure Modes — "Offline | Panel shows cached last-fetched messages (per-topic LRU cache in `storage.local`, ~50 topics), composer disabled"). Second sub-project of **M2** (Robust), after **M2a** (backlog sweep, complete at v0.7.2).

## Goal

Keep each discussion readable when the realm is unreachable: cache the last-fetched messages per topic in `storage.local`, and when a history fetch fails on a network error, show the cached messages for the current thread with an offline banner and a send-blocked (but still draftable) composer — replacing them with fresh data and clearing the offline state on the next successful fetch.

## Scope

In:
- A per-`topicKey` LRU cache of last-fetched messages in `chrome.storage.local` (~50 topics), with eviction that stays within the default quota (no new permission).
- Offline detection at the panel by distinguishing a `fetch` network failure (`TypeError`) from a `ZulipError` (HTTP status).
- Fallback in `loadHistory`: write the cache on a successful fetch; on a network-error fetch, show the cached messages (or empty) and enter offline mode; on a non-network error, keep the existing error-banner path.
- Offline UI: a banner, and a composer that stays editable (draft preserved) but blocks send.
- Clearing offline on the next successful fetch (reconnect event + a `window` `online` listener).

Out (explicit non-goals):
- No stale-while-revalidate — the cache is a *fallback* on failure, not shown pre-emptively while online.
- Live events (`append`/`update`/`remove`/`reaction`) do **not** update the cache; the next successful `loadHistory` refreshes it ("last-fetched" semantics).
- Message *actions* (edit/delete/react) are not specially disabled offline; if attempted they surface a normal error (rare while offline) — a possible follow-up.
- No `"unlimitedStorage"` permission.

## Design

### Cache module (`src/shared/messageCache.ts` — new)

- Types:
  ```ts
  interface CacheEntry { messages: ZulipMessage[]; at: number } // at = last-access epoch ms (LRU)
  type MessageCacheMap = Record<string, CacheEntry>              // key = topicKey
  ```
- Pure, chrome-free **`cacheReducer(map, action): MessageCacheMap`**:
  - `{ type: 'put'; topicKey; messages; now; cap }` — set `map[topicKey] = { messages, at: now }`; if the resulting size exceeds `cap`, evict the entries with the smallest `at` until size equals `cap`. Returns a new map.
  - `{ type: 'touch'; topicKey; now }` — if `topicKey` is present, set its `at = now` (returns a new map); if absent, returns the **same reference** (no-op).
  - `CACHE_CAP = 50` exported.
- **`createMessageCache(area = chrome.storage.local, changed?, areaName = 'local')`** — a store with its own serialized read-modify-write over the **whole** map (the generic `createStore` shallow-merges and cannot delete keys, which eviction requires), key `msgCache`:
  - `save(topicKey: string, messages: ZulipMessage[]): Promise<void>` — read map, apply `put` with `now = Date.now()`, `cap = CACHE_CAP`, write the whole map. On a write rejection whose message includes `QUOTA_BYTES` (quota exceeded), evict more aggressively (drop to `CACHE_CAP / 2` by LRU via repeated eviction) and retry the write once; a second failure is swallowed (best-effort cache).
  - `load(topicKey: string): Promise<ZulipMessage[] | null>` — read map; if `map[topicKey]` exists, fire a best-effort `touch` write (LRU bump, not awaited for the return) and return its `messages`; else return `null`.
  - Writes are serialized through a promise chain (same pattern as `createStore`) so concurrent `save`/`touch` can't interleave a lost update.

### Offline detection (`src/shared/netError.ts` — new)

```ts
/** A fetch that never reached the server rejects with TypeError (unreachable realm,
 *  DNS, TLS) — distinct from ZulipError (an HTTP status). */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError
}
```
`ZulipClient.request` throws `ZulipError` only after a response is received, so a true connectivity failure propagates as the `fetch` `TypeError` — making this a clean, robust offline signal (it also catches the self-signed-cert `Failed to fetch` case).

### Panel wiring (`src/panel/App.tsx`)

- Module-level singleton `const messageCache = createMessageCache()` (alongside `drafts`/`settingsStore`).
- New state `const [offline, setOffline] = useState(false)`.
- `loadHistory(topic, forUri, topicKey)` gains the thread's `topicKey` (callers already have `t.key` / `key`) and becomes:
  ```ts
  async function loadHistory(topic, forUri, topicKey) {
    const client = clientRef.current; const creds = credsRef.current
    if (!client || !creds) return
    try {
      const fetched = await client.getMessages(creds.channelName, topic)
      if (targetRef.current.currentUri !== forUri) return
      dispatch({ type: 'history', messages: fetched })
      setOffline(false)
      void messageCache.save(topicKey, fetched)
    } catch (e) {
      if (!isNetworkError(e)) throw e            // 429/403/etc → existing error path
      const cached = await messageCache.load(topicKey)
      if (targetRef.current.currentUri !== forUri) return
      dispatch({ type: 'history', messages: cached ?? [] })
      setOffline(true)
    }
  }
  ```
  All call sites pass the topicKey (`initThread` has `key`; the reconnect/message-move handlers use `t.key`).
- A `window` `online` listener (added in the port `useEffect` or a dedicated one) re-runs `loadHistory` for the current thread so recovery isn't solely dependent on the SW `reconnected` event; removed on cleanup. The existing `reconnected` handler already re-runs `loadHistory` and thus clears offline on success.

### Offline UI (`src/panel/App.tsx`, `src/panel/Composer.tsx`)

- Banner (rendered above the composer when `offline` and a thread exists): `Offline — showing last saved messages. Reconnect to send.` (class `offline-banner`, styled with the existing `--pt-*` tokens).
- `Composer` gains an `offline?: boolean` prop:
  - textarea stays editable (its `disabled` remains `disabled` only — drafts keep working);
  - the send button is `disabled={disabled || busy || offline || !value.trim()}`;
  - `submit()` returns early when `offline`, and the Enter-to-send keydown is guarded by `offline`;
  - when `offline`, the textarea placeholder becomes `Offline — reconnect to send` (the send-unavailable hint); otherwise it stays `Write a message…`.
- `App` passes `offline={offline}` to `Composer`.

### Version / manifest

- Version → **0.8.0** (`package.json` + `public/manifest.json`). No manifest permission change (`storage` already declared; `storage.local` needs nothing more).

## Testing

- **Unit — `messageCache.test.ts`:** `cacheReducer` put creates/overwrites an entry with `at = now`; exceeding `cap` evicts the least-recently-used (smallest `at`); `touch` bumps `at` and returns the same reference when the key is absent. `createMessageCache` on a fake area: `save`→`load` round-trips messages; a sequence past `cap` evicts the LRU topic; a fake area that rejects the first `set` with a `QUOTA_BYTES` message triggers aggressive eviction + a successful retry.
- **Unit — `netError.test.ts`:** `isNetworkError(new TypeError('Failed to fetch'))` → true; `isNetworkError(new ZulipError('HTTP 429', 'RATE_LIMIT'))` → false; `isNetworkError(new Error('x'))` → false.
- **Component — `Composer.test.tsx` (extend):** with `offline`, the textarea is editable and reflects input, the send button is disabled, and pressing Enter does not call `onSend`.
- **Manual acceptance:** open a thread online (populates the cache); stop the realm (OrbStack down or block it) and reopen/switch to that thread → cached messages show with the offline banner and send disabled while the textarea still accepts a draft; restart the realm → on reconnect the thread refreshes with live data and the banner clears; a thread never opened online shows empty + offline banner (nothing cached); confirm the cache stays bounded after visiting many topics.

## Acceptance

1. A thread viewed online is readable again from cache when the realm is unreachable, with an offline banner (WHAT.md §8).
2. While offline the composer accepts a draft but send is disabled; the draft can be sent once reconnected.
3. On reconnect (SW event or `window` `online`) the thread refreshes with live data and the offline state clears.
4. The cache is a per-`topicKey` LRU bounded to ~50 topics in `storage.local`, evicting the least-recently-used and staying within the default quota (no new permission).
5. A non-network error (e.g. 429) keeps the existing error-banner behavior, not the offline path.
6. Version 0.8.0; all existing tests pass; new unit/component tests cover the cache, `isNetworkError`, and the offline composer.

/**
 * A fetch that never reached the server rejects with TypeError (unreachable
 * realm, DNS failure, TLS/cert rejection) — distinct from ZulipError, which is
 * only thrown after an HTTP response is received.
 */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError
}

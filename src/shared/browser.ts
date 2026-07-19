/**
 * Cross-browser extension API. Firefox exposes the promise-based `browser.*`
 * namespace natively; Chrome does not, so fall back to `chrome` (whose MV3 APIs
 * already return promises). This module is the single seam the (deferred) Firefox
 * port will revisit — every other module imports `browser` from here rather than
 * touching `chrome`/`browser` globals directly.
 */
export function resolveBrowser(
  scope: { browser?: typeof chrome; chrome?: typeof chrome } = globalThis as typeof globalThis & {
    browser?: typeof chrome
  }
): typeof chrome {
  return (scope.browser ?? scope.chrome)!
}

export const browser: typeof chrome = resolveBrowser()

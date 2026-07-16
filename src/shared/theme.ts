import type { SettingsStore } from './settings'

export type ThemePref = 'system' | 'light' | 'dark'

/** Collapse the stored preference + the OS setting into the theme to actually apply. */
export function resolveEffectiveTheme(pref: ThemePref, prefersDark: boolean): 'light' | 'dark' {
  if (pref === 'system') return prefersDark ? 'dark' : 'light'
  return pref
}

export interface MediaQueryListLike {
  matches: boolean
  addEventListener(type: 'change', cb: () => void): void
  removeEventListener(type: 'change', cb: () => void): void
}

export function applyTheme(root: HTMLElement, effective: 'light' | 'dark'): void {
  if (effective === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
}

/**
 * Keep <html data-theme> in sync with the theme setting and the OS preference.
 * Paints once synchronously (from the OS preference) to avoid a flash before the
 * async settings load resolves, then corrects. Returns an unsubscribe.
 */
export function startThemeSync(deps: {
  store: Pick<SettingsStore, 'load' | 'watch'>
  root: HTMLElement
  mql: MediaQueryListLike
}): () => void {
  let pref: ThemePref = 'system'
  const paint = () => applyTheme(deps.root, resolveEffectiveTheme(pref, deps.mql.matches))
  paint()
  const onMql = () => paint()
  deps.mql.addEventListener('change', onMql)
  const unwatch = deps.store.watch((s) => {
    pref = s.theme
    paint()
  })
  void deps.store.load().then((s) => {
    pref = s.theme
    paint()
  })
  return () => {
    deps.mql.removeEventListener('change', onMql)
    unwatch()
  }
}

export type ThemePref = 'system' | 'light' | 'dark'

/** Collapse the stored preference + the OS setting into the theme to actually apply. */
export function resolveEffectiveTheme(pref: ThemePref, prefersDark: boolean): 'light' | 'dark' {
  if (pref === 'system') return prefersDark ? 'dark' : 'light'
  return pref
}

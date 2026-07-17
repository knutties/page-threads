import { describe, expect, test } from 'vitest'
import { resolveEffectiveTheme } from './theme'

describe('resolveEffectiveTheme', () => {
  test('system follows the OS preference', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark')
    expect(resolveEffectiveTheme('system', false)).toBe('light')
  })

  test('explicit light/dark ignore the OS preference', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light')
    expect(resolveEffectiveTheme('light', false)).toBe('light')
    expect(resolveEffectiveTheme('dark', true)).toBe('dark')
    expect(resolveEffectiveTheme('dark', false)).toBe('dark')
  })
})

import { applyTheme, startThemeSync, type ThemePref } from './theme'
import { DEFAULT_SETTINGS, type Settings } from './settings'

function fakeRoot() {
  const attrs: Record<string, string> = {}
  return {
    setAttribute: (k: string, v: string) => { attrs[k] = v },
    removeAttribute: (k: string) => { delete attrs[k] },
    get dataTheme() { return attrs['data-theme'] },
  }
}

function fakeStore(initial: ThemePref) {
  let cb: ((s: Settings) => void) | null = null
  return {
    load: async () => ({ ...DEFAULT_SETTINGS, theme: initial }),
    watch: (c: (s: Settings) => void) => { cb = c; return () => { cb = null } },
    fire: (t: ThemePref) => cb?.({ ...DEFAULT_SETTINGS, theme: t }),
  }
}

function fakeMql(matches: boolean) {
  let cb: (() => void) | null = null
  return {
    matches,
    addEventListener: (_t: 'change', c: () => void) => { cb = c },
    removeEventListener: () => { cb = null },
    fire(next: boolean) { this.matches = next; cb?.() },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('applyTheme', () => {
  test('dark sets the attribute, light removes it', () => {
    const root = fakeRoot()
    applyTheme(root as unknown as HTMLElement, 'dark')
    expect(root.dataTheme).toBe('dark')
    applyTheme(root as unknown as HTMLElement, 'light')
    expect(root.dataTheme).toBeUndefined()
  })
})

describe('startThemeSync', () => {
  test('paints from the OS preference synchronously before the store loads', () => {
    const root = fakeRoot()
    const mql = fakeMql(true) // OS = dark
    startThemeSync({ store: fakeStore('system') as never, root: root as unknown as HTMLElement, mql })
    expect(root.dataTheme).toBe('dark') // system + OS dark, before load resolves
  })

  test('applies the stored preference once it loads (overrides OS)', async () => {
    const root = fakeRoot()
    const mql = fakeMql(true) // OS = dark
    startThemeSync({ store: fakeStore('light') as never, root: root as unknown as HTMLElement, mql })
    await flush()
    expect(root.dataTheme).toBeUndefined() // explicit light beats OS dark
  })

  test('repaints when the OS flips while in system mode', async () => {
    const root = fakeRoot()
    const mql = fakeMql(false) // OS = light
    startThemeSync({ store: fakeStore('system') as never, root: root as unknown as HTMLElement, mql })
    await flush()
    expect(root.dataTheme).toBeUndefined()
    mql.fire(true)
    expect(root.dataTheme).toBe('dark')
  })

  test('repaints when the setting changes', async () => {
    const root = fakeRoot()
    const mql = fakeMql(false)
    const store = fakeStore('system')
    startThemeSync({ store: store as never, root: root as unknown as HTMLElement, mql })
    await flush()
    store.fire('dark')
    expect(root.dataTheme).toBe('dark')
  })

  test('unsubscribe stops reacting to OS flips', async () => {
    const root = fakeRoot()
    const mql = fakeMql(false)
    const stop = startThemeSync({ store: fakeStore('system') as never, root: root as unknown as HTMLElement, mql })
    await flush()
    stop()
    mql.fire(true)
    expect(root.dataTheme).toBeUndefined() // listener removed
  })
})

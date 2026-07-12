export interface Settings {
  /** Panel behavior when the active tab has no web entity (chrome://, new tab). */
  onNonWebPage: 'hold' | 'clear'
}

export const DEFAULT_SETTINGS: Settings = {
  onNonWebPage: 'hold',
}

interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void

interface StorageChangedLike {
  addListener(cb: ChangeListener): void
  removeListener(cb: ChangeListener): void
}

export interface SettingsStore {
  load(): Promise<Settings>
  save(patch: Partial<Settings>): Promise<void>
  watch(cb: (settings: Settings) => void): () => void
}

const KEY = 'settings'

/** chrome.* appears only as default arguments so Node tests can inject fakes. */
export function createSettingsStore(
  area: StorageAreaLike = chrome.storage.local,
  changed: StorageChangedLike = chrome.storage.onChanged,
  areaName = 'local'
): SettingsStore {
  async function load(): Promise<Settings> {
    const stored = (await area.get(KEY))[KEY] as Partial<Settings> | undefined
    return { ...DEFAULT_SETTINGS, ...stored }
  }

  return {
    load,
    async save(patch) {
      const current = await load()
      await area.set({ [KEY]: { ...current, ...patch } })
    },
    watch(cb) {
      const listener: ChangeListener = (changes, name) => {
        if (name === areaName && changes[KEY]) {
          cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<Settings> | undefined) })
        }
      }
      changed.addListener(listener)
      return () => changed.removeListener(listener)
    },
  }
}

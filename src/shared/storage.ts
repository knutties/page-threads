export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export type ChangeListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string
) => void

export interface StorageChangedLike {
  addListener(cb: ChangeListener): void
  removeListener(cb: ChangeListener): void
}

export interface Store<T> {
  load(): Promise<T>
  save(patch: Partial<T>): Promise<void>
  watch(cb: (value: T) => void): () => void
}

/**
 * Typed key in a chrome.storage-like area with defaults, change watching, and
 * SERIALIZED read-merge-write saves (concurrent saves of different fields must
 * both land — reviewed race from M1a). chrome.* appears only as default
 * arguments so Node tests can inject fakes.
 */
export function createStore<T extends object>(
  key: string,
  defaults: T,
  area: StorageAreaLike = chrome.storage.local,
  changed: StorageChangedLike = chrome.storage.onChanged,
  areaName = 'local'
): Store<T> {
  let writeChain: Promise<void> = Promise.resolve()

  async function load(): Promise<T> {
    const stored = (await area.get(key))[key] as Partial<T> | undefined
    return { ...defaults, ...stored }
  }

  return {
    load,
    save(patch) {
      const next = writeChain.then(async () => {
        const current = await load()
        await area.set({ [key]: { ...current, ...patch } })
      })
      // A rejected save must not wedge the queue for later saves.
      writeChain = next.catch(() => {})
      return next
    },
    watch(cb) {
      const listener: ChangeListener = (changes, name) => {
        if (name === areaName && changes[key]) {
          cb({ ...defaults, ...(changes[key].newValue as Partial<T> | undefined) })
        }
      }
      changed.addListener(listener)
      return () => changed.removeListener(listener)
    },
  }
}

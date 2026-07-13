import {
  createStore,
  type StorageAreaLike,
  type StorageChangedLike,
  type Store,
} from './storage'

export interface Settings {
  /** Panel behavior when the active tab has no web entity (chrome://, new tab). */
  onNonWebPage: 'hold' | 'clear'
}

export const DEFAULT_SETTINGS: Settings = {
  onNonWebPage: 'hold',
}

export type SettingsStore = Store<Settings>

export function createSettingsStore(
  area?: StorageAreaLike,
  changed?: StorageChangedLike,
  areaName = 'local'
): SettingsStore {
  return createStore('settings', DEFAULT_SETTINGS, area, changed, areaName)
}

import {
  createStore,
  type StorageAreaLike,
  type StorageChangedLike,
  type Store,
} from './storage'
import type { ThemePref } from './theme'

export interface Settings {
  /** Panel behavior when the active tab has no web entity (chrome://, new tab). */
  onNonWebPage: 'hold' | 'clear'
  /** 'auto' resolves the thread when the panel opens; 'manual' waits for a click (strict privacy). */
  resolveMode: 'auto' | 'manual'
  /** Panel/options color theme. 'system' follows the OS light/dark setting. */
  theme: ThemePref
}

export const DEFAULT_SETTINGS: Settings = {
  onNonWebPage: 'hold',
  resolveMode: 'auto',
  theme: 'system',
}

export type SettingsStore = Store<Settings>

export function createSettingsStore(
  area?: StorageAreaLike,
  changed?: StorageChangedLike,
  areaName = 'local'
): SettingsStore {
  return createStore('settings', DEFAULT_SETTINGS, area, changed, areaName)
}

import { useEffect, useState } from 'preact/hooks'
import type { Ruleset } from '../shared/ruleset'
import { createSettingsStore, DEFAULT_SETTINGS, type Settings, type SettingsStore } from '../shared/settings'
import type { Store } from '../shared/storage'
import { RulesEditor } from './RulesEditor'

export function OptionsView({
  store = createSettingsStore(),
  rulesStore,
}: {
  store?: SettingsStore
  rulesStore?: Store<Ruleset>
}) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void store.load().then((s) => {
      setSettings(s)
      setLoaded(true)
    })
    return store.watch(setSettings)
  }, [])

  async function update(patch: Partial<Settings>) {
    const prev = settings
    setSettings({ ...settings, ...patch })
    try {
      await store.save(patch)
    } catch {
      setSettings(prev)
      setError('Could not save — try again.')
    }
  }

  if (!loaded) return <div class="loading">Loading…</div>

  return (
    <div class="options">
      <h1>PageThreads settings</h1>
      {error && <div class="error" role="alert" onClick={() => setError(null)}>{error}</div>}

      <section>
        <label>
          <input
            type="checkbox"
            checked={settings.resolveMode === 'manual'}
            onChange={(e) =>
              void update({ resolveMode: (e.target as HTMLInputElement).checked ? 'manual' : 'auto' })
            }
          />
          Strict privacy: don't contact the realm until I click "Check for discussion"
        </label>
        <p class="hint">
          When on, opening the panel shows the page title and a button; no request is made to your Zulip
          realm for a page until you ask.
        </p>
      </section>

      <section>
        <label>
          <input
            type="checkbox"
            checked={settings.onNonWebPage === 'hold'}
            onChange={(e) =>
              void update({ onNonWebPage: (e.target as HTMLInputElement).checked ? 'hold' : 'clear' })
            }
          />
          On a non-web page (new tab, chrome://), keep the last thread visible
        </label>
        <p class="hint">When off, the panel clears and disables the composer on non-web pages.</p>
      </section>

      <RulesEditor store={rulesStore} />
    </div>
  )
}

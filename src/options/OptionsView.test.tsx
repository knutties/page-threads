// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, test } from 'vitest'
import type { Ruleset } from '../shared/ruleset'
import type { Settings, SettingsStore } from '../shared/settings'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { Store } from '../shared/storage'
import { OptionsView } from './OptionsView'

function fakeStore(initial: Settings = DEFAULT_SETTINGS): SettingsStore & { current: Settings } {
  let current = { ...initial }
  const store = {
    current,
    load: async () => current,
    save: async (patch: Partial<Settings>) => {
      current = { ...current, ...patch }
      ;(store as { current: Settings }).current = current
    },
    watch: () => () => {},
  }
  return store as SettingsStore & { current: Settings }
}

function fakeRulesStore(initial: Ruleset = { canonical: {}, blocked: [] }): Store<Ruleset> {
  let current = { ...initial }
  return {
    load: async () => current,
    save: async (patch: Partial<Ruleset>) => {
      current = { ...current, ...patch }
    },
    watch: () => () => {},
  }
}

describe('OptionsView', () => {
  test('reflects stored values on load', async () => {
    render(
      <OptionsView store={fakeStore({ onNonWebPage: 'clear', resolveMode: 'manual', theme: 'system' })} rulesStore={fakeRulesStore()} />
    )
    const strict = (await screen.findByLabelText(/Strict privacy/i)) as HTMLInputElement
    expect(strict.checked).toBe(true)
    const hold = (await screen.findByLabelText(/keep the last thread/i)) as HTMLInputElement
    expect(hold.checked).toBe(false)
  })

  test('toggling strict privacy writes resolveMode', async () => {
    const store = fakeStore()
    render(<OptionsView store={store} rulesStore={fakeRulesStore()} />)
    const strict = (await screen.findByLabelText(/Strict privacy/i)) as HTMLInputElement
    expect(strict.checked).toBe(false)
    fireEvent.click(strict)
    await waitFor(() => expect(store.current.resolveMode).toBe('manual'))
  })

  test('toggling the non-web-page option writes onNonWebPage', async () => {
    const store = fakeStore()
    render(<OptionsView store={store} rulesStore={fakeRulesStore()} />)
    const hold = (await screen.findByLabelText(/keep the last thread/i)) as HTMLInputElement
    fireEvent.click(hold) // was checked (hold); unchecking selects 'clear'
    await waitFor(() => expect(store.current.onNonWebPage).toBe('clear'))
  })

  test('a failed save reverts the toggle and shows an error', async () => {
    const store = fakeStore()
    store.save = async () => {
      throw new Error('quota')
    }
    render(<OptionsView store={store} rulesStore={fakeRulesStore()} />)
    const strict = (await screen.findByLabelText(/Strict privacy/i)) as HTMLInputElement
    fireEvent.click(strict)
    await waitFor(() => expect(screen.getByText(/Could not save/i)).toBeTruthy())
    expect(strict.checked).toBe(false) // reverted
  })

  test('changing Appearance writes the theme setting', async () => {
    const store = fakeStore()
    render(<OptionsView store={store} rulesStore={fakeRulesStore()} />)
    const select = (await screen.findByLabelText(/Appearance/i)) as HTMLSelectElement
    expect(select.value).toBe('system')
    fireEvent.change(select, { target: { value: 'dark' } })
    await waitFor(() => expect(store.current.theme).toBe('dark'))
  })

  test('a successful save clears a prior error banner', async () => {
    const store = fakeStore()
    let failNext = true
    const ok = store.save.bind(store)
    store.save = async (patch: Partial<Settings>) => {
      if (failNext) {
        failNext = false
        throw new Error('quota')
      }
      return ok(patch)
    }
    render(<OptionsView store={store} rulesStore={fakeRulesStore()} />)
    const strict = (await screen.findByLabelText(/Strict privacy/i)) as HTMLInputElement
    fireEvent.click(strict) // first save fails → banner appears
    await waitFor(() => expect(screen.getByText(/Could not save/i)).toBeTruthy())
    fireEvent.click(strict) // second save succeeds → banner clears
    await waitFor(() => expect(screen.queryByText(/Could not save/i)).toBeNull())
  })
})

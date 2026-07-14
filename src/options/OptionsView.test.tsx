// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, test } from 'vitest'
import type { Settings, SettingsStore } from '../shared/settings'
import { DEFAULT_SETTINGS } from '../shared/settings'
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

describe('OptionsView', () => {
  test('reflects stored values on load', async () => {
    render(<OptionsView store={fakeStore({ onNonWebPage: 'clear', resolveMode: 'manual' })} />)
    const strict = (await screen.findByLabelText(/Strict privacy/i)) as HTMLInputElement
    expect(strict.checked).toBe(true)
    const hold = (await screen.findByLabelText(/keep the last thread/i)) as HTMLInputElement
    expect(hold.checked).toBe(false)
  })

  test('toggling strict privacy writes resolveMode', async () => {
    const store = fakeStore()
    render(<OptionsView store={store} />)
    const strict = (await screen.findByLabelText(/Strict privacy/i)) as HTMLInputElement
    expect(strict.checked).toBe(false)
    fireEvent.click(strict)
    await waitFor(() => expect(store.current.resolveMode).toBe('manual'))
  })

  test('toggling the non-web-page option writes onNonWebPage', async () => {
    const store = fakeStore()
    render(<OptionsView store={store} />)
    const hold = (await screen.findByLabelText(/keep the last thread/i)) as HTMLInputElement
    fireEvent.click(hold) // was checked (hold); unchecking selects 'clear'
    await waitFor(() => expect(store.current.onNonWebPage).toBe('clear'))
  })
})

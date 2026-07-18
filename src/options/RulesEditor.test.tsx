// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, test } from 'vitest'
import type { Ruleset } from '../shared/ruleset'
import type { Store } from '../shared/storage'
import { RulesEditor } from './RulesEditor'

function fakeStore(initial: Ruleset): Store<Ruleset> & { current: Ruleset } {
  const s = {
    current: { ...initial },
    load: async () => s.current,
    save: async (patch: Partial<Ruleset>) => {
      s.current = { ...s.current, ...patch }
    },
    watch: () => () => {},
  }
  return s as Store<Ruleset> & { current: Ruleset }
}

function watchableStore(initial: Ruleset): Store<Ruleset> & { current: Ruleset; emit: (r: Ruleset) => void } {
  let cb: ((r: Ruleset) => void) | null = null
  const s = {
    current: { ...initial },
    load: async () => s.current,
    save: async (patch: Partial<Ruleset>) => {
      s.current = { ...s.current, ...patch }
    },
    watch: (fn: (r: Ruleset) => void) => {
      cb = fn
      return () => {
        cb = null
      }
    },
    emit: (r: Ruleset) => cb?.(r),
  }
  return s as Store<Ruleset> & { current: Ruleset; emit: (r: Ruleset) => void }
}

describe('RulesEditor', () => {
  test('renders existing domain rows', async () => {
    const store = fakeStore({ canonical: { 'news.ycombinator.com': { keepParams: ['id'] } }, blocked: [] })
    render(<RulesEditor store={store} />)
    expect(await screen.findByDisplayValue('news.ycombinator.com')).toBeTruthy()
    expect(screen.getByDisplayValue('id')).toBeTruthy()
  })

  test('adding a domain writes through the store', async () => {
    const store = fakeStore({ canonical: {}, blocked: [] })
    render(<RulesEditor store={store} />)
    await screen.findByText('Canonicalization rules')
    fireEvent.input(screen.getByPlaceholderText('add domain, e.g. news.ycombinator.com'), {
      target: { value: 'x.com' },
    })
    fireEvent.click(screen.getByText('Add domain'))
    await waitFor(() => expect(store.current.canonical['x.com']).toEqual({}))
  })

  test('editing keepParams writes a parsed array', async () => {
    const store = fakeStore({ canonical: { 'x.com': {} }, blocked: [] })
    render(<RulesEditor store={store} />)
    const kp = (await screen.findByPlaceholderText('keepParams (comma-separated)')) as HTMLInputElement
    fireEvent.input(kp, { target: { value: 'id, v' } })
    fireEvent.blur(kp)
    await waitFor(() => expect(store.current.canonical['x.com'].keepParams).toEqual(['id', 'v']))
  })

  test('blocking a domain writes through the store', async () => {
    const store = fakeStore({ canonical: {}, blocked: [] })
    render(<RulesEditor store={store} />)
    await screen.findByText('Blocked domains')
    fireEvent.input(screen.getByPlaceholderText('add blocked domain'), { target: { value: 'bank.com' } })
    fireEvent.click(screen.getByText('Block'))
    await waitFor(() => expect(store.current.blocked).toContain('bank.com'))
  })

  test('import rejects invalid JSON with a visible message and does not change state', async () => {
    const store = fakeStore({ canonical: {}, blocked: [] })
    render(<RulesEditor store={store} />)
    const ta = (await screen.findByPlaceholderText('paste ruleset JSON to import')) as HTMLTextAreaElement
    fireEvent.input(ta, { target: { value: '{ not json' } })
    fireEvent.click(screen.getByText('Import'))
    expect(await screen.findByText(/Invalid JSON/i)).toBeTruthy()
    expect(store.current.canonical).toEqual({})
  })

  test('export reflects current rules as JSON', async () => {
    const store = fakeStore({ canonical: { 'x.com': { keepParams: ['id'] } }, blocked: ['a.com'] })
    render(<RulesEditor store={store} />)
    fireEvent.click(await screen.findByText('Export'))
    const out = (await screen.findByLabelText('exported ruleset')) as HTMLTextAreaElement
    expect(JSON.parse(out.value)).toEqual({ canonical: { 'x.com': { keepParams: ['id'] } }, blocked: ['a.com'] })
  })

  test('shows a Saved confirmation after a change persists', async () => {
    const store = fakeStore({ canonical: {}, blocked: [] })
    render(<RulesEditor store={store} />)
    await screen.findByText('Blocked domains')
    fireEvent.input(screen.getByPlaceholderText('add blocked domain'), { target: { value: 'a.com' } })
    fireEvent.click(screen.getByText('Block'))
    expect(await screen.findByText('Saved ✓')).toBeTruthy()
  })

  test('a successful save clears a prior error banner', async () => {
    const store = fakeStore({ canonical: {}, blocked: [] })
    let failNext = true
    store.save = async (patch: Partial<Ruleset>) => {
      if (failNext) {
        failNext = false
        throw new Error('quota')
      }
      store.current = { ...store.current, ...patch }
    }
    render(<RulesEditor store={store} />)
    await screen.findByText('Blocked domains')
    fireEvent.input(screen.getByPlaceholderText('add blocked domain'), { target: { value: 'a.com' } })
    fireEvent.click(screen.getByText('Block')) // fails → banner
    await waitFor(() => expect(screen.getByText(/Could not save/i)).toBeTruthy())
    fireEvent.input(screen.getByPlaceholderText('add blocked domain'), { target: { value: 'b.com' } })
    fireEvent.click(screen.getByText('Block')) // succeeds → banner clears
    await waitFor(() => expect(screen.queryByText(/Could not save/i)).toBeNull())
  })

  test('a remote watch update does not clobber a focused input; it applies after blur', async () => {
    const store = watchableStore({ canonical: { 'x.com': { keepParams: ['id'] } }, blocked: [] })
    render(<RulesEditor store={store} />)
    const kp = (await screen.findByPlaceholderText('keepParams (comma-separated)')) as HTMLInputElement
    kp.focus()
    fireEvent.focusIn(kp)
    store.emit({ canonical: { 'x.com': { keepParams: ['REMOTE'] } }, blocked: [] })
    // still shows the focused value, not the remote one
    expect((screen.getByPlaceholderText('keepParams (comma-separated)') as HTMLInputElement).value).toBe('id')
    fireEvent.focusOut(kp)
    await waitFor(() =>
      expect((screen.getByPlaceholderText('keepParams (comma-separated)') as HTMLInputElement).value).toBe('REMOTE')
    )
  })

  test('visibilitychange=hidden commits an unblurred keepParams edit', async () => {
    const store = fakeStore({ canonical: { 'x.com': {} }, blocked: [] })
    render(<RulesEditor store={store} />)
    const kp = (await screen.findByPlaceholderText('keepParams (comma-separated)')) as HTMLInputElement
    kp.focus()
    fireEvent.input(kp, { target: { value: 'id' } })
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(store.current.canonical['x.com'].keepParams).toEqual(['id']))
    if (original) Object.defineProperty(document, 'visibilityState', original)
  })
})

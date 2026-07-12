import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createNavWatcher } from './navWatcher'

describe('createNavWatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('a burst of triggers resolves once after the debounce window', () => {
    const resolve = vi.fn(() => 'web:b')
    const onChange = vi.fn()
    const w = createNavWatcher({ resolve, onChange })
    w.seed('web:a')
    w.trigger()
    w.trigger()
    w.trigger()
    expect(resolve).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('web:b')
  })

  test('unchanged uri → no onChange', () => {
    const onChange = vi.fn()
    const w = createNavWatcher({ resolve: () => 'web:a', onChange })
    w.seed('web:a')
    w.trigger()
    vi.advanceTimersByTime(150)
    expect(onChange).not.toHaveBeenCalled()
  })

  test('dedupes across separate navigations (a→b→b fires once)', () => {
    let uri = 'web:b'
    const onChange = vi.fn()
    const w = createNavWatcher({ resolve: () => uri, onChange })
    w.seed('web:a')
    w.trigger()
    vi.advanceTimersByTime(150)
    w.trigger() // still web:b
    vi.advanceTimersByTime(150)
    expect(onChange).toHaveBeenCalledTimes(1)
    uri = 'web:c'
    w.trigger()
    vi.advanceTimersByTime(150)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith('web:c')
  })

  test('custom debounce window is honored', () => {
    const onChange = vi.fn()
    const w = createNavWatcher({ resolve: () => 'web:b', onChange, debounceMs: 500 })
    w.seed('web:a')
    w.trigger()
    vi.advanceTimersByTime(499)
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onChange).toHaveBeenCalledWith('web:b')
  })
})

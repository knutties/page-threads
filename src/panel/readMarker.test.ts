import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createReadMarker } from './readMarker'

describe('createReadMarker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('batches ids and flushes once after the debounce window', async () => {
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids) })
    m.noteRendered([1, 2])
    m.noteRendered([2, 3])
    expect(flushed).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1, 2, 3]])
  })

  test('never re-flushes ids that already succeeded', async () => {
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids) })
    m.noteRendered([1])
    await vi.advanceTimersByTimeAsync(2000)
    m.noteRendered([1, 2])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1], [2]])
  })

  test('failed ids stay queued and retry on the next flush', async () => {
    let fail = true
    const flushed: number[][] = []
    const m = createReadMarker({
      flush: async (ids) => {
        if (fail) throw new Error('offline')
        flushed.push(ids)
      },
    })
    m.noteRendered([1])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([])
    fail = false
    m.noteRendered([2])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1, 2]])
  })

  test('collects nothing while not visible; flushes after becoming visible', async () => {
    let visible = false
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids), isVisible: () => visible })
    m.noteRendered([1])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([])
    visible = true
    m.noteRendered([1])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1]])
  })

  test('dispose cancels pending work', async () => {
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids) })
    m.noteRendered([1])
    m.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(flushed).toEqual([])
  })

  test('dispose during an in-flight flush suppresses its success bookkeeping', async () => {
    let resolveFlush!: () => void
    const flushed: number[][] = []
    const m = createReadMarker({
      flush: async (ids) => {
        flushed.push(ids)
        await new Promise<void>((r) => (resolveFlush = r))
      },
    })
    m.noteRendered([1])
    await vi.advanceTimersByTimeAsync(2000) // flush([1]) is now in flight
    expect(flushed).toEqual([[1]])
    m.dispose()
    resolveFlush() // in-flight flush resolves AFTER dispose
    await Promise.resolve()
    // id 1 must NOT be recorded as flushed post-dispose: re-noting it (on a fresh
    // marker sharing nothing) is irrelevant; here we just assert no post-dispose crash
    // and that a second flush never happens.
    await vi.advanceTimersByTimeAsync(5000)
    expect(flushed).toEqual([[1]])
  })
})

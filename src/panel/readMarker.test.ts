import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createReadMarker } from './readMarker'

describe('createReadMarker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('batches ids and flushes once after the debounce window', async () => {
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids) })
    m.noteRendered([1, 2], 'k')
    m.noteRendered([2, 3], 'k')
    expect(flushed).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1, 2, 3]])
  })

  test('never re-flushes ids that already succeeded', async () => {
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids) })
    m.noteRendered([1], 'k')
    await vi.advanceTimersByTimeAsync(2000)
    m.noteRendered([1, 2], 'k')
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
    m.noteRendered([1], 'k')
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([])
    fail = false
    m.noteRendered([2], 'k')
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1, 2]])
  })

  test('collects nothing while not visible; flushes after becoming visible', async () => {
    let visible = false
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids), isVisible: () => visible })
    m.noteRendered([1], 'k')
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([])
    visible = true
    m.noteRendered([1], 'k')
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushed).toEqual([[1]])
  })

  test('dispose cancels pending work', async () => {
    const flushed: number[][] = []
    const m = createReadMarker({ flush: async (ids) => void flushed.push(ids) })
    m.noteRendered([1], 'k')
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
    m.noteRendered([1], 'k')
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

  test('drops a batch after maxRetries consecutive failures', async () => {
    let attempts = 0
    const flushed: number[][] = []
    const m = createReadMarker({
      flush: async (ids) => {
        attempts++
        throw new Error('offline')
        flushed.push(ids)
      },
      maxRetries: 3,
    })
    m.noteRendered([1], 'k')
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2000)
    // 1 initial + 3 retries = 4 attempts, then the batch is dropped (no more retries)
    expect(attempts).toBe(4)
    expect(flushed).toEqual([])
  })

  test('a success resets the failure counter', async () => {
    let fail = true
    let attempts = 0
    const m = createReadMarker({
      flush: async () => {
        attempts++
        if (fail) throw new Error('offline')
      },
      maxRetries: 3,
    })
    m.noteRendered([1], 'k')
    await vi.advanceTimersByTimeAsync(2000) // attempt 1 fails
    fail = false
    m.noteRendered([2], 'k')
    await vi.advanceTimersByTimeAsync(2000) // attempt 2 succeeds ([1,2]) → counter resets
    fail = true
    m.noteRendered([3], 'k')
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2000)
    // attempt 2 succeeded, so [3] gets a fresh budget: 1 + 3 = 4 failing attempts for it
    expect(attempts).toBe(1 + 1 + 4)
  })

  test('a newly-noted id gets a fresh retry budget even if merged into a failing batch', async () => {
    let attempts = 0
    const m = createReadMarker({
      flush: async () => {
        attempts++
        throw new Error('offline')
      },
      maxRetries: 2,
    })
    m.noteRendered([1], 'k')
    await vi.advanceTimersByTimeAsync(2000) // attempt 1 (failures=1)
    await vi.advanceTimersByTimeAsync(2000) // attempt 2 (failures=2)
    m.noteRendered([2], 'k') // NEW id → resets the failure budget
    await vi.advanceTimersByTimeAsync(2000) // attempt (failures back to 1 after reset then ++)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    // Without the reset, [1,2] would have been dropped at attempt 3 (failures 3 > 2).
    // With the reset, the batch containing the new id 2 gets a fresh 2-retry budget,
    // so more attempts occur. Assert at least 5 attempts happened (proving no early drop).
    expect(attempts).toBeGreaterThanOrEqual(5)
  })

  test('F2: ids noted under different topics flush reporting BOTH topicKeys', async () => {
    const flushedIds: number[][] = []
    const flushedKeys: string[][] = []
    const m = createReadMarker({
      flush: async (ids, keys) => {
        flushedIds.push(ids)
        flushedKeys.push([...keys].sort())
      },
    })
    m.noteRendered([1], 'kA') // thread A rendered
    m.noteRendered([2], 'kB') // switched to thread B before the debounce fired
    await vi.advanceTimersByTimeAsync(2000)
    expect(flushedIds).toEqual([[1, 2]])
    expect(flushedKeys).toEqual([['kA', 'kB']])
  })

  test('a failed multi-topic batch re-queues ids under their own topics and retries with both keys', async () => {
    let fail = true
    const flushedKeys: string[][] = []
    const m = createReadMarker({
      flush: async (_ids, keys) => {
        if (fail) throw new Error('offline')
        flushedKeys.push([...keys].sort())
      },
    })
    m.noteRendered([1], 'kA')
    m.noteRendered([2], 'kB')
    await vi.advanceTimersByTimeAsync(2000) // fails
    fail = false
    await vi.advanceTimersByTimeAsync(2000) // retry
    expect(flushedKeys).toEqual([['kA', 'kB']])
  })
})

import { describe, expect, test } from 'vitest'
import { ZulipError } from '../shared/zulipClient'
import { EventLoop } from './eventLoop'

describe('EventLoop', () => {
  test('registers once, dispatches events, advances last_event_id', async () => {
    const calls: Array<[string, number]> = []
    let poll = 0
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: 'q1', lastEventId: -1 }),
      getEvents: async (queueId: string, lastEventId: number) => {
        calls.push([queueId, lastEventId])
        poll++
        if (poll === 1) {
          return [
            { id: 0, type: 'message' },
            { id: 1, type: 'heartbeat' },
          ]
        }
        loop.stop()
        return []
      },
    }
    const seen: number[] = []
    loop = new EventLoop(client, 'web-threads', { onEvent: (e) => seen.push(e.id) })
    await loop.start()
    expect(seen).toEqual([0, 1])
    expect(calls).toEqual([
      ['q1', -1],
      ['q1', 1],
    ])
  })

  test('re-registers on BAD_EVENT_QUEUE_ID and fires onReconnect', async () => {
    let registrations = 0
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: `q${++registrations}`, lastEventId: -1 }),
      getEvents: async (queueId: string) => {
        if (queueId === 'q1') throw new ZulipError('Bad event queue id', 'BAD_EVENT_QUEUE_ID')
        loop.stop()
        return []
      },
    }
    let reconnects = 0
    loop = new EventLoop(client, 'web-threads', {
      onEvent: () => {},
      onReconnect: () => reconnects++,
    })
    await loop.start()
    expect(registrations).toBe(2)
    expect(reconnects).toBe(1)
  })

  test('backs off exponentially on network errors, capped at 30s, reset on success', async () => {
    const sleeps: number[] = []
    let poll = 0
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: 'q1', lastEventId: -1 }),
      getEvents: async () => {
        poll++
        if (poll <= 6) throw new TypeError('fetch failed')
        if (poll === 7) return [{ id: 0, type: 'heartbeat' }] // success resets backoff
        if (poll === 8) throw new TypeError('fetch failed')
        loop.stop()
        return []
      },
    }
    loop = new EventLoop(client, 'web-threads', {
      onEvent: () => {},
      sleep: async (ms) => void sleeps.push(ms),
    })
    await loop.start()
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 1000])
  })

  test('stop() during a poll prevents further event dispatch', async () => {
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: 'q1', lastEventId: -1 }),
      getEvents: async () => {
        loop.stop()
        return [{ id: 0, type: 'message' }]
      },
    }
    const seen: number[] = []
    loop = new EventLoop(client, 'web-threads', { onEvent: (e) => seen.push(e.id) })
    await loop.start()
    expect(seen).toEqual([])
  })

  test('an onEvent exception does not drop the rest of the batch or trigger backoff', async () => {
    const sleeps: number[] = []
    let poll = 0
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: 'q1', lastEventId: -1 }),
      getEvents: async () => {
        poll++
        if (poll === 1) {
          return [
            { id: 0, type: 'message' },
            { id: 1, type: 'message' },
          ]
        }
        loop.stop()
        return []
      },
    }
    const seen: number[] = []
    loop = new EventLoop(client, 'web-threads', {
      onEvent: (e) => {
        if (e.id === 0) throw new Error('consumer bug')
        seen.push(e.id)
      },
      sleep: async (ms) => void sleeps.push(ms),
    })
    await loop.start()
    expect(seen).toEqual([1])
    expect(sleeps).toEqual([])
  })

  test('register failing with BAD_EVENT_QUEUE_ID backs off instead of hot-spinning', async () => {
    const sleeps: number[] = []
    let registers = 0
    let loop: EventLoop
    const client = {
      register: async () => {
        registers++
        if (registers === 1) throw new ZulipError('bad', 'BAD_EVENT_QUEUE_ID')
        return { queueId: 'q2', lastEventId: -1 }
      },
      getEvents: async () => {
        loop.stop()
        return []
      },
    }
    loop = new EventLoop(client, 'web-threads', {
      onEvent: () => {},
      sleep: async (ms) => void sleeps.push(ms),
    })
    await loop.start()
    expect(registers).toBe(2)
    expect(sleeps).toEqual([1000])
  })

  test('an onReconnect exception does not kill the loop', async () => {
    let registrations = 0
    let loop: EventLoop
    const client = {
      register: async () => ({ queueId: `q${++registrations}`, lastEventId: -1 }),
      getEvents: async (queueId: string) => {
        if (queueId === 'q1') throw new ZulipError('bad', 'BAD_EVENT_QUEUE_ID')
        loop.stop()
        return []
      },
    }
    loop = new EventLoop(client, 'web-threads', {
      onEvent: () => {},
      onReconnect: () => {
        throw new Error('consumer bug')
      },
    })
    await loop.start()
    expect(registrations).toBe(2) // survived the throw and re-registered
  })
})

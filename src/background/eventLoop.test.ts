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
})

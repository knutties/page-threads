import type { ZulipClient, ZulipEvent } from '../shared/zulipClient'
import { ZulipError } from '../shared/zulipClient'

export interface EventLoopHooks {
  onEvent: (event: ZulipEvent) => void
  onReconnect?: () => void
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000

export class EventLoop {
  private running = false

  constructor(
    private client: Pick<ZulipClient, 'register' | 'getEvents'>,
    private channel: string,
    private hooks: EventLoopHooks
  ) {}

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const sleep = this.hooks.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    let backoff = INITIAL_BACKOFF_MS
    let queue: { queueId: string; lastEventId: number } | null = null
    let lostQueue = false // set on a queue loss; cleared when we successfully re-register

    while (this.running) {
      try {
        if (!queue) {
          queue = await this.client.register(this.channel)
          if (lostQueue) {
            lostQueue = false
            try {
              this.hooks.onReconnect?.()
            } catch {
              // A consumer bug must not kill the loop (mirrors the onEvent guard).
            }
          }
        }
        const events = await this.client.getEvents(queue.queueId, queue.lastEventId)
        backoff = INITIAL_BACKOFF_MS
        for (const event of events) {
          if (event.id > queue.lastEventId) queue.lastEventId = event.id
          if (!this.running) break
          try {
            this.hooks.onEvent(event)
          } catch {
            // A consumer bug must not kill the loop or drop the rest of the batch.
          }
        }
      } catch (e) {
        if (!this.running) return
        if (e instanceof ZulipError && e.code === 'BAD_EVENT_QUEUE_ID') {
          lostQueue = true
          if (queue) {
            queue = null
            continue // stale queue surfaced by getEvents: re-register immediately (no backoff)
          }
          // register() itself failed with this code: fall through to backoff (no hot-spin)
        }
        await sleep(backoff)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    }
  }

  stop(): void {
    this.running = false
  }
}

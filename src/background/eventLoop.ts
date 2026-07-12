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

    while (this.running) {
      try {
        if (!queue) queue = await this.client.register(this.channel)
        const events = await this.client.getEvents(queue.queueId, queue.lastEventId)
        backoff = INITIAL_BACKOFF_MS
        for (const event of events) {
          if (event.id > queue.lastEventId) queue.lastEventId = event.id
          if (this.running) this.hooks.onEvent(event)
        }
      } catch (e) {
        if (!this.running) return
        if (e instanceof ZulipError && e.code === 'BAD_EVENT_QUEUE_ID') {
          queue = null
          this.hooks.onReconnect?.()
          continue
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

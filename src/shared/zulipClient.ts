export interface ZulipConfig {
  realmUrl: string
  email: string
  apiKey: string
}

export interface ZulipMessage {
  id: number
  sender_full_name: string
  sender_email: string
  content: string
  timestamp: number
  subject: string // Zulip's field name for the topic
}

export interface ZulipEvent {
  id: number
  type: string
  message?: ZulipMessage
}

export class ZulipError extends Error {
  constructor(msg: string, readonly code?: string) {
    super(msg)
    this.name = 'ZulipError'
  }
}

export class ZulipClient {
  constructor(private cfg: ZulipConfig, private fetchFn: typeof fetch = fetch) {}

  private async request(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, unknown>
  ): Promise<any> {
    const url = new URL(`/api/v1${path}`, this.cfg.realmUrl)
    const init: RequestInit = {
      method,
      headers: { Authorization: 'Basic ' + btoa(`${this.cfg.email}:${this.cfg.apiKey}`) },
    }
    if (params) {
      const encoded = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        encoded.set(k, typeof v === 'string' ? v : JSON.stringify(v))
      }
      if (method === 'GET') url.search = encoded.toString()
      else init.body = encoded
    }
    const res = await this.fetchFn(url.toString(), init)
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.result !== 'success') {
      throw new ZulipError(data.msg ?? `HTTP ${res.status}`, data.code)
    }
    return data
  }

  async getStreamId(name: string): Promise<number> {
    return (await this.request('GET', '/get_stream_id', { stream: name })).stream_id
  }

  async getTopics(streamId: number): Promise<string[]> {
    const data = await this.request('GET', `/users/me/${streamId}/topics`)
    return data.topics.map((t: { name: string }) => t.name)
  }

  async getMessages(channel: string, topic: string): Promise<ZulipMessage[]> {
    const data = await this.request('GET', '/messages', {
      anchor: 'newest',
      num_before: 50,
      num_after: 0,
      apply_markdown: false,
      narrow: [
        { operator: 'channel', operand: channel },
        { operator: 'topic', operand: topic },
      ],
    })
    return data.messages
  }

  async sendMessage(channel: string, topic: string, content: string): Promise<number> {
    const data = await this.request('POST', '/messages', {
      type: 'stream',
      to: channel,
      topic,
      content,
    })
    return data.id
  }

  async register(channel: string): Promise<{ queueId: string; lastEventId: number }> {
    const data = await this.request('POST', '/register', {
      event_types: ['message'],
      narrow: [['channel', channel]],
    })
    return { queueId: data.queue_id, lastEventId: data.last_event_id }
  }

  async getEvents(queueId: string, lastEventId: number): Promise<ZulipEvent[]> {
    const data = await this.request('GET', '/events', {
      queue_id: queueId,
      last_event_id: lastEventId,
    })
    return data.events
  }
}

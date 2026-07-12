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

interface ZulipSuccess {
  result: 'success'
  msg: string
}

export interface GetStreamIdResponse extends ZulipSuccess {
  stream_id: number
}

export interface GetTopicsResponse extends ZulipSuccess {
  topics: Array<{ name: string; max_id: number }>
}

export interface GetMessagesResponse extends ZulipSuccess {
  messages: ZulipMessage[]
}

export interface SendMessageResponse extends ZulipSuccess {
  id: number
}

export interface RegisterResponse extends ZulipSuccess {
  queue_id: string
  last_event_id: number
}

export interface GetEventsResponse extends ZulipSuccess {
  events: ZulipEvent[]
}

export class ZulipError extends Error {
  constructor(msg: string, readonly code?: string) {
    super(msg)
    this.name = 'ZulipError'
  }
}

export class ZulipClient {
  private fetchFn: typeof fetch

  constructor(private cfg: ZulipConfig, fetchFn?: typeof fetch) {
    // Calling `this.fetchFn(...)` would hand the browser's fetch a foreign
    // receiver ("Illegal invocation"); pin the receiver to globalThis.
    this.fetchFn = (fetchFn ?? fetch).bind(globalThis)
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, unknown>
  ): Promise<T> {
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
    return data as T
  }

  async getStreamId(name: string): Promise<number> {
    return (await this.request<GetStreamIdResponse>('GET', '/get_stream_id', { stream: name })).stream_id
  }

  async getTopics(streamId: number): Promise<string[]> {
    const data = await this.request<GetTopicsResponse>('GET', `/users/me/${streamId}/topics`)
    return data.topics.map((t) => t.name)
  }

  async getMessages(channel: string, topic: string): Promise<ZulipMessage[]> {
    const data = await this.request<GetMessagesResponse>('GET', '/messages', {
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
    const data = await this.request<SendMessageResponse>('POST', '/messages', {
      type: 'stream',
      to: channel,
      topic,
      content,
    })
    return data.id
  }

  async register(channel: string): Promise<{ queueId: string; lastEventId: number }> {
    const data = await this.request<RegisterResponse>('POST', '/register', {
      event_types: ['message'],
      narrow: [['channel', channel]],
    })
    return { queueId: data.queue_id, lastEventId: data.last_event_id }
  }

  async getEvents(queueId: string, lastEventId: number): Promise<ZulipEvent[]> {
    const data = await this.request<GetEventsResponse>('GET', '/events', {
      queue_id: queueId,
      last_event_id: lastEventId,
    })
    return data.events
  }
}

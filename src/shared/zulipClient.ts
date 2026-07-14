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
  reactions?: ZulipReaction[]
}

export interface ZulipReaction {
  emoji_name: string
  emoji_code: string
  reaction_type: string
  user_id: number
}

export interface ZulipEvent {
  id: number
  type: string
  message?: ZulipMessage
  message_id?: number
  rendered_content?: string
  subject?: string
  orig_subject?: string
  op?: 'add' | 'remove'
  emoji_name?: string
  emoji_code?: string
  reaction_type?: string
  user_id?: number
}

export interface ZulipSuccess {
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

export interface GetSingleMessageResponse extends ZulipSuccess {
  message: { content: string }
}

export interface RegisterResponse extends ZulipSuccess {
  queue_id: string
  last_event_id: number
}

export interface GetEventsResponse extends ZulipSuccess {
  events: ZulipEvent[]
}

export interface ServerSettings {
  passwordAuthEnabled: boolean
  realmName: string
  zulipVersion: string
}

export interface GetOwnUserResponse {
  result: 'success'
  msg: string
  email: string
  delivery_email?: string
  full_name: string
  user_id: number
}

export class ZulipError extends Error {
  constructor(msg: string, readonly code?: string) {
    super(msg)
    this.name = 'ZulipError'
  }
}

async function unauthenticatedRequest(
  realmUrl: string,
  path: string,
  init: RequestInit | undefined,
  fetchFn: typeof fetch
): Promise<any> {
  const f = fetchFn.bind(globalThis)
  const res = await f(new URL(`/api/v1${path}`, realmUrl).toString(), init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.result !== 'success') {
    throw new ZulipError(data.msg ?? `HTTP ${res.status}`, data.code)
  }
  return data
}

export class ZulipClient {
  private fetchFn: typeof fetch

  constructor(private cfg: ZulipConfig, fetchFn?: typeof fetch) {
    // Calling `this.fetchFn(...)` would hand the browser's fetch a foreign
    // receiver ("Illegal invocation"); pin the receiver to globalThis.
    this.fetchFn = (fetchFn ?? fetch).bind(globalThis)
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
      apply_markdown: true,
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
      event_types: ['message', 'update_message', 'delete_message', 'reaction'],
      narrow: [['channel', channel]],
      apply_markdown: true,
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

  /** Unauthenticated realm probe (GET /server_settings). */
  static async probeServer(realmUrl: string, fetchFn: typeof fetch = fetch): Promise<ServerSettings> {
    const data = await unauthenticatedRequest(realmUrl, '/server_settings', undefined, fetchFn)
    return {
      passwordAuthEnabled: Boolean(data.authentication_methods?.password),
      realmName: data.realm_name ?? '',
      zulipVersion: data.zulip_version ?? '',
    }
  }

  /** Exchange email+password for an API key (POST /fetch_api_key). Password is not retained. */
  static async fetchApiKey(
    realmUrl: string,
    email: string,
    password: string,
    fetchFn: typeof fetch = fetch
  ): Promise<string> {
    const body = new URLSearchParams({ username: email, password })
    const data = await unauthenticatedRequest(realmUrl, '/fetch_api_key', { method: 'POST', body }, fetchFn)
    return data.api_key
  }

  async getOwnUser(): Promise<{ email: string; fullName: string; userId: number }> {
    const data = await this.request<GetOwnUserResponse>('GET', '/users/me')
    return { email: data.delivery_email ?? data.email, fullName: data.full_name, userId: data.user_id }
  }

  async getRawMessage(id: number): Promise<string> {
    const data = await this.request<GetSingleMessageResponse>('GET', `/messages/${id}`, {
      apply_markdown: false,
    })
    return data.message.content
  }

  async updateMessage(id: number, content: string): Promise<void> {
    await this.request<ZulipSuccess>('PATCH', `/messages/${id}`, { content })
  }

  async deleteMessage(id: number): Promise<void> {
    await this.request<ZulipSuccess>('DELETE', `/messages/${id}`)
  }

  async addReaction(id: number, emojiName: string): Promise<void> {
    await this.request<ZulipSuccess>('POST', `/messages/${id}/reactions`, { emoji_name: emojiName })
  }

  async removeReaction(id: number, emojiName: string): Promise<void> {
    await this.request<ZulipSuccess>('DELETE', `/messages/${id}/reactions`, { emoji_name: emojiName })
  }

  async markRead(ids: number[]): Promise<void> {
    await this.request<ZulipSuccess>('POST', '/messages/flags', { messages: ids, op: 'add', flag: 'read' })
  }
}

import { describe, expect, test } from 'vitest'
import { ZulipClient, ZulipError } from './zulipClient'

const cfg = { realmUrl: 'http://localhost:9090', email: 'me@x.com', apiKey: 'secret' }

function fakeFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fn = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(payload), { status })
  }) as typeof fetch
  return { fn, calls }
}

describe('fetch receiver', () => {
  test('never invokes fetchFn with a foreign this (browser fetch throws Illegal invocation)', async () => {
    function strictFetch(this: unknown, _url: RequestInfo | URL, _init?: RequestInit) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      }
      return Promise.resolve(new Response(JSON.stringify({ result: 'success', stream_id: 1 })))
    }
    await expect(new ZulipClient(cfg, strictFetch as typeof fetch).getStreamId('x')).resolves.toBe(1)
  })

  test('default fetch path never binds a foreign this either', async () => {
    function strictGlobalFetch(this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      }
      return Promise.resolve(new Response(JSON.stringify({ result: 'success', stream_id: 2 })))
    }
    const original = globalThis.fetch
    globalThis.fetch = strictGlobalFetch as typeof fetch
    try {
      await expect(new ZulipClient(cfg).getStreamId('x')).resolves.toBe(2)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('auth and encoding', () => {
  test('sends HTTP basic auth header', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', stream_id: 7 })
    await new ZulipClient(cfg, fn).getStreamId('web-threads')
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + btoa('me@x.com:secret')
    )
  })

  test('GET params go in the query string, JSON-encoding non-strings', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', messages: [] })
    await new ZulipClient(cfg, fn).getMessages('web-threads', 'T · k')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/v1/messages')
    expect(url.searchParams.get('anchor')).toBe('newest')
    expect(url.searchParams.get('num_before')).toBe('50')
    expect(url.searchParams.get('apply_markdown')).toBe('true')
    expect(JSON.parse(url.searchParams.get('narrow')!)).toEqual([
      { operator: 'channel', operand: 'web-threads' },
      { operator: 'topic', operand: 'T · k' },
    ])
  })

  test('POST params go form-encoded in the body', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', id: 42 })
    const id = await new ZulipClient(cfg, fn).sendMessage('web-threads', 'T · k', 'hello')
    expect(id).toBe(42)
    expect(calls[0].init!.method).toBe('POST')
    const body = calls[0].init!.body as URLSearchParams
    expect(body.get('type')).toBe('stream')
    expect(body.get('to')).toBe('web-threads')
    expect(body.get('topic')).toBe('T · k')
    expect(body.get('content')).toBe('hello')
  })
})

describe('endpoints', () => {
  test('getStreamId', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', stream_id: 7 })
    expect(await new ZulipClient(cfg, fn).getStreamId('web-threads')).toBe(7)
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/v1/get_stream_id')
    expect(url.searchParams.get('stream')).toBe('web-threads')
  })

  test('getTopics returns names', async () => {
    const { fn, calls } = fakeFetch({
      result: 'success',
      topics: [{ name: 'A · k1', max_id: 5 }, { name: 'B · k2', max_id: 9 }],
    })
    expect(await new ZulipClient(cfg, fn).getTopics(7)).toEqual(['A · k1', 'B · k2'])
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/users/me/7/topics')
  })

  test('register maps queue fields and narrows to the channel', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', queue_id: 'q9', last_event_id: -1 })
    const q = await new ZulipClient(cfg, fn).register('web-threads')
    expect(q).toEqual({ queueId: 'q9', lastEventId: -1 })
    const body = calls[0].init!.body as URLSearchParams
    expect(JSON.parse(body.get('event_types')!)).toEqual(['message', 'update_message', 'delete_message', 'reaction'])
    expect(JSON.parse(body.get('narrow')!)).toEqual([['channel', 'web-threads']])
    expect(body.get('apply_markdown')).toBe('true')
  })

  test('getEvents returns events array', async () => {
    const { fn, calls } = fakeFetch({ result: 'success', events: [{ id: 3, type: 'heartbeat' }] })
    const events = await new ZulipClient(cfg, fn).getEvents('q9', 2)
    expect(events).toEqual([{ id: 3, type: 'heartbeat' }])
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/v1/events')
    expect(url.searchParams.get('queue_id')).toBe('q9')
    expect(url.searchParams.get('last_event_id')).toBe('2')
  })
})

describe('errors', () => {
  test('Zulip error payload throws ZulipError with msg and code', async () => {
    const { fn } = fakeFetch(
      { result: 'error', msg: 'Bad event queue id', code: 'BAD_EVENT_QUEUE_ID' },
      400
    )
    const err = await new ZulipClient(cfg, fn).getEvents('q', 0).catch((e) => e)
    expect(err).toBeInstanceOf(ZulipError)
    expect(err.message).toBe('Bad event queue id')
    expect(err.code).toBe('BAD_EVENT_QUEUE_ID')
  })

  test('non-JSON error response throws with HTTP status', async () => {
    const fn = (async () => new Response('<html>gateway timeout</html>', { status: 502 })) as typeof fetch
    const err = await new ZulipClient(cfg, fn).getStreamId('x').catch((e) => e)
    expect(err).toBeInstanceOf(ZulipError)
    expect(err.message).toBe('HTTP 502')
  })
})

describe('onboarding endpoints', () => {
  test('probeServer hits /server_settings without auth and maps fields', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fn = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({
          result: 'success',
          authentication_methods: { password: true, dev: false },
          realm_name: 'Acme',
          zulip_version: '12.1',
        })
      )
    }) as typeof fetch
    const s = await ZulipClient.probeServer('https://acme.zulipchat.com', fn)
    expect(s).toEqual({ passwordAuthEnabled: true, realmName: 'Acme', zulipVersion: '12.1' })
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/server_settings')
    expect(calls[0].init).toBeUndefined()
  })

  test('probeServer reports password disabled', async () => {
    const fn = (async () =>
      new Response(
        JSON.stringify({ result: 'success', authentication_methods: { password: false }, realm_name: 'A', zulip_version: 'x' })
      )) as typeof fetch
    expect((await ZulipClient.probeServer('https://a.com', fn)).passwordAuthEnabled).toBe(false)
  })

  test('fetchApiKey posts form-encoded username/password with no auth header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fn = (async (url: any, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ result: 'success', api_key: 'sekrit', email: 'me@x.com' }))
    }) as typeof fetch
    const key = await ZulipClient.fetchApiKey('https://a.com', 'me@x.com', 'hunter2', fn)
    expect(key).toBe('sekrit')
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/fetch_api_key')
    expect(calls[0].init.method).toBe('POST')
    const body = calls[0].init.body as URLSearchParams
    expect(body.get('username')).toBe('me@x.com')
    expect(body.get('password')).toBe('hunter2')
    expect((calls[0].init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined()
  })

  test('fetchApiKey surfaces Zulip error message', async () => {
    const fn = (async () =>
      new Response(JSON.stringify({ result: 'error', msg: 'Your username or password is incorrect', code: 'AUTHENTICATION_FAILED' }), {
        status: 403,
      })) as typeof fetch
    const err = await ZulipClient.fetchApiKey('https://a.com', 'e', 'p', fn).catch((e) => e)
    expect(err).toBeInstanceOf(ZulipError)
    expect(err.message).toBe('Your username or password is incorrect')
  })

  test('getOwnUser maps delivery_email and full_name with basic auth', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fn = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({ result: 'success', email: 'bot@x.com', delivery_email: 'me@x.com', full_name: 'Me Myself' })
      )
    }) as typeof fetch
    const me = await new ZulipClient(cfg, fn).getOwnUser()
    expect(me).toEqual({ email: 'me@x.com', fullName: 'Me Myself' })
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/users/me')
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toContain('Basic ')
  })
})

describe('message features endpoints', () => {
  function capture(payload: unknown) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fn = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(payload))
    }) as typeof fetch
    return { fn, calls }
  }

  test('getRawMessage fetches a single message unrendered', async () => {
    const { fn, calls } = capture({ result: 'success', message: { content: '**raw**' } })
    expect(await new ZulipClient(cfg, fn).getRawMessage(42)).toBe('**raw**')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/v1/messages/42')
    expect(url.searchParams.get('apply_markdown')).toBe('false')
  })

  test('updateMessage PATCHes content', async () => {
    const { fn, calls } = capture({ result: 'success' })
    await new ZulipClient(cfg, fn).updateMessage(42, 'new text')
    expect(calls[0].init!.method).toBe('PATCH')
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/messages/42')
    expect((calls[0].init!.body as URLSearchParams).get('content')).toBe('new text')
  })

  test('deleteMessage DELETEs', async () => {
    const { fn, calls } = capture({ result: 'success' })
    await new ZulipClient(cfg, fn).deleteMessage(42)
    expect(calls[0].init!.method).toBe('DELETE')
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/messages/42')
  })

  test('addReaction / removeReaction hit the reactions resource', async () => {
    const { fn, calls } = capture({ result: 'success' })
    const client = new ZulipClient(cfg, fn)
    await client.addReaction(42, 'thumbs_up')
    await client.removeReaction(42, 'thumbs_up')
    expect(calls[0].init!.method).toBe('POST')
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/messages/42/reactions')
    expect((calls[0].init!.body as URLSearchParams).get('emoji_name')).toBe('thumbs_up')
    expect(calls[1].init!.method).toBe('DELETE')
    expect((calls[1].init!.body as URLSearchParams).get('emoji_name')).toBe('thumbs_up')
  })

  test('markRead posts message ids with the read flag', async () => {
    const { fn, calls } = capture({ result: 'success', messages: [1, 2] })
    await new ZulipClient(cfg, fn).markRead([1, 2])
    expect(calls[0].init!.method).toBe('POST')
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/messages/flags')
    const body = calls[0].init!.body as URLSearchParams
    expect(JSON.parse(body.get('messages')!)).toEqual([1, 2])
    expect(body.get('op')).toBe('add')
    expect(body.get('flag')).toBe('read')
  })

  test('getOwnUser includes userId', async () => {
    const { fn } = capture({
      result: 'success',
      email: 'e',
      delivery_email: 'me@x.com',
      full_name: 'Me',
      user_id: 17,
    })
    expect(await new ZulipClient(cfg, fn).getOwnUser()).toEqual({
      email: 'me@x.com',
      fullName: 'Me',
      userId: 17,
    })
  })
})

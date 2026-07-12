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
    expect(url.searchParams.get('apply_markdown')).toBe('false')
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
    expect(JSON.parse(body.get('event_types')!)).toEqual(['message'])
    expect(JSON.parse(body.get('narrow')!)).toEqual([['channel', 'web-threads']])
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

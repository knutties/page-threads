import { describe, expect, test } from 'vitest'
import { createLifecycle } from './lifecycle'

const CREDS = { realmUrl: 'https://a.com', email: 'e', apiKey: 'k', channelName: 'web-threads' }

function fakeLoopFactory() {
  const loops: Array<{ started: boolean; stopped: boolean; creds: unknown }> = []
  return {
    loops,
    makeLoop(creds: unknown) {
      const loop = { started: false, stopped: false, creds }
      loops.push(loop)
      return {
        start: async () => void (loop.started = true),
        stop: () => void (loop.stopped = true),
      }
    },
  }
}

describe('createLifecycle', () => {
  test('cold start: port connects before credentials load; loop starts once load resolves', async () => {
    const f = fakeLoopFactory()
    let resolveLoad!: (c: typeof CREDS | null) => void
    const lc = createLifecycle({
      loadCredentials: () => new Promise((r) => (resolveLoad = r)),
      makeLoop: f.makeLoop,
    })
    const init = lc.init()
    lc.portConnected()
    expect(f.loops).toHaveLength(0)
    resolveLoad(CREDS)
    await init
    expect(f.loops).toHaveLength(1)
    expect(f.loops[0].started).toBe(true)
  })

  test('no credentials → no loop; no ports → no loop', async () => {
    const f = fakeLoopFactory()
    const lc = createLifecycle({ loadCredentials: async () => null, makeLoop: f.makeLoop })
    await lc.init()
    lc.portConnected()
    expect(f.loops).toHaveLength(0)
    lc.portDisconnected()
    const lc2 = createLifecycle({ loadCredentials: async () => CREDS, makeLoop: f.makeLoop })
    await lc2.init()
    expect(f.loops).toHaveLength(0) // credentials but no port
  })

  test('setCredentials(null) stops the loop; new credentials restart it', async () => {
    const f = fakeLoopFactory()
    const lc = createLifecycle({ loadCredentials: async () => CREDS, makeLoop: f.makeLoop })
    await lc.init()
    lc.portConnected()
    expect(f.loops).toHaveLength(1)
    lc.setCredentials(null)
    expect(f.loops[0].stopped).toBe(true)
    lc.setCredentials({ ...CREDS, email: 'other' })
    expect(f.loops).toHaveLength(2)
    expect((f.loops[1].creds as typeof CREDS).email).toBe('other')
  })

  test('double restart never leaves two live loops', async () => {
    const f = fakeLoopFactory()
    const lc = createLifecycle({ loadCredentials: async () => CREDS, makeLoop: f.makeLoop })
    await lc.init()
    lc.portConnected()
    lc.setCredentials(CREDS)
    lc.setCredentials(CREDS)
    expect(f.loops).toHaveLength(3)
    expect(f.loops[0].stopped).toBe(true)
    expect(f.loops[1].stopped).toBe(true)
    expect(f.loops[2].stopped).toBe(false)
  })

  test('last port disconnect stops the loop; reconnect restarts it', async () => {
    const f = fakeLoopFactory()
    const lc = createLifecycle({ loadCredentials: async () => CREDS, makeLoop: f.makeLoop })
    await lc.init()
    lc.portConnected()
    lc.portConnected()
    lc.portDisconnected()
    expect(f.loops[0].stopped).toBe(false) // one port still connected
    lc.portDisconnected()
    expect(f.loops[0].stopped).toBe(true)
    lc.portConnected()
    expect(f.loops).toHaveLength(2)
  })

  test('reloadCredentials picks up the latest stored value', async () => {
    const f = fakeLoopFactory()
    let stored: typeof CREDS | null = CREDS
    const lc = createLifecycle({ loadCredentials: async () => stored, makeLoop: f.makeLoop })
    await lc.init()
    lc.portConnected()
    stored = null
    await lc.reloadCredentials()
    expect(f.loops[0].stopped).toBe(true)
    expect(f.loops).toHaveLength(1)
  })
})

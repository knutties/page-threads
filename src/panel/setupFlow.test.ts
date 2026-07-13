import { describe, expect, test } from 'vitest'
import { INITIAL_SETUP, setupReducer, type SetupState } from './setupFlow'

const INFO = { passwordAuthEnabled: true, realmName: 'Acme' }

function reduce(events: Parameters<typeof setupReducer>[1][], from: SetupState = INITIAL_SETUP) {
  return events.reduce(setupReducer, from)
}

describe('setupReducer', () => {
  test('starts on the realm step, not busy', () => {
    expect(INITIAL_SETUP.step).toBe('realm')
    expect(INITIAL_SETUP.busy).toBe(false)
  })

  test('probe lifecycle: started sets busy, ok advances to auth with server info', () => {
    const s = reduce([
      { type: 'probeStarted' },
      { type: 'probeOk', realmUrl: 'https://a.com', serverInfo: INFO },
    ])
    expect(s).toMatchObject({ step: 'auth', realmUrl: 'https://a.com', serverInfo: INFO, busy: false, error: null })
  })

  test('probeOk defaults the tab to password when available, apikey otherwise', () => {
    expect(reduce([{ type: 'probeOk', realmUrl: 'x', serverInfo: INFO }]).authTab).toBe('password')
    expect(
      reduce([{ type: 'probeOk', realmUrl: 'x', serverInfo: { ...INFO, passwordAuthEnabled: false } }]).authTab
    ).toBe('apikey')
  })

  test('probeFailed stays on realm with the message, clears busy', () => {
    const s = reduce([{ type: 'probeStarted' }, { type: 'probeFailed', message: 'unreachable' }])
    expect(s).toMatchObject({ step: 'realm', busy: false, error: 'unreachable' })
  })

  test('auth lifecycle: started sets busy and clears prior error; failed surfaces message', () => {
    const s = reduce([
      { type: 'probeOk', realmUrl: 'x', serverInfo: INFO },
      { type: 'authStarted' },
      { type: 'authFailed', message: 'bad password' },
    ])
    expect(s).toMatchObject({ step: 'auth', busy: false, error: 'bad password' })
    expect(setupReducer(s, { type: 'authStarted' }).error).toBeNull()
  })

  test('tabChanged switches tab and clears error', () => {
    const s = reduce([
      { type: 'probeOk', realmUrl: 'x', serverInfo: INFO },
      { type: 'authFailed', message: 'nope' },
      { type: 'tabChanged', tab: 'apikey' },
    ])
    expect(s).toMatchObject({ authTab: 'apikey', error: null })
  })

  test('back returns to the realm step, clearing busy and error', () => {
    const s = reduce([
      { type: 'probeOk', realmUrl: 'x', serverInfo: INFO },
      { type: 'authFailed', message: 'channel missing' },
      { type: 'back' },
    ])
    expect(s).toMatchObject({ step: 'realm', busy: false, error: null })
    expect(s.realmUrl).toBe('x') // kept for re-probe convenience
  })
})

import { describe, expect, test } from 'vitest'
import { panelTarget, type PanelTargetState } from './panelTarget'

const entity = (uri: string) => ({ entityUri: uri, title: 'T' })
const s = (pinned: boolean, currentUri: string | null): PanelTargetState => ({ pinned, currentUri })

describe('panelTarget', () => {
  test('push of a new uri while unpinned → switch and track it', () => {
    const r = panelTarget(s(false, null), { type: 'push', entity: entity('web:a') }, 'hold')
    expect(r).toEqual({ state: s(false, 'web:a'), action: 'switch' })
  })

  test('push of the same uri → ignore', () => {
    const r = panelTarget(s(false, 'web:a'), { type: 'push', entity: entity('web:a') }, 'hold')
    expect(r.action).toBe('ignore')
    expect(r.state).toEqual(s(false, 'web:a'))
  })

  test('push of a different uri → switch', () => {
    const r = panelTarget(s(false, 'web:a'), { type: 'push', entity: entity('web:b') }, 'hold')
    expect(r).toEqual({ state: s(false, 'web:b'), action: 'switch' })
  })

  test('any push while pinned → ignore, state unchanged', () => {
    expect(panelTarget(s(true, 'web:a'), { type: 'push', entity: entity('web:b') }, 'hold').action).toBe('ignore')
    expect(panelTarget(s(true, 'web:a'), { type: 'push', entity: null }, 'clear').action).toBe('ignore')
  })

  test('null push while unpinned, mode hold → ignore (thread stays)', () => {
    const r = panelTarget(s(false, 'web:a'), { type: 'push', entity: null }, 'hold')
    expect(r).toEqual({ state: s(false, 'web:a'), action: 'ignore' })
  })

  test('null push while unpinned, mode clear → clear and forget uri', () => {
    const r = panelTarget(s(false, 'web:a'), { type: 'push', entity: null }, 'clear')
    expect(r).toEqual({ state: s(false, null), action: 'clear' })
  })

  test('null push when already showing nothing → ignore in both modes', () => {
    expect(panelTarget(s(false, null), { type: 'push', entity: null }, 'hold').action).toBe('ignore')
    expect(panelTarget(s(false, null), { type: 'push', entity: null }, 'clear').action).toBe('ignore')
  })

  test('pin → pinned, ignore', () => {
    expect(panelTarget(s(false, 'web:a'), { type: 'pin' }, 'hold')).toEqual({
      state: s(true, 'web:a'),
      action: 'ignore',
    })
  })

  test('unpin → unpinned, refresh (caller re-requests active entity)', () => {
    expect(panelTarget(s(true, 'web:a'), { type: 'unpin' }, 'hold')).toEqual({
      state: s(false, 'web:a'),
      action: 'refresh',
    })
  })

  test('initFailed for the current uri forgets it so a re-push switches again', () => {
    const failed = panelTarget(s(false, 'web:a'), { type: 'initFailed', uri: 'web:a' }, 'hold')
    expect(failed).toEqual({ state: s(false, null), action: 'ignore' })
    const retry = panelTarget(failed.state, { type: 'push', entity: entity('web:a') }, 'hold')
    expect(retry.action).toBe('switch')
  })

  test('initFailed for a stale uri leaves state untouched', () => {
    const r = panelTarget(s(false, 'web:b'), { type: 'initFailed', uri: 'web:a' }, 'hold')
    expect(r).toEqual({ state: s(false, 'web:b'), action: 'ignore' })
  })
})

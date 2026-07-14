import { describe, expect, test } from 'vitest'
import { createBadgeManager } from './badgeManager'

function setup(over: Partial<Parameters<typeof createBadgeManager>[0]> = {}) {
  const badges: Array<[number, string]> = []
  const persisted: Array<Record<string, number>> = []
  const mgr = createBadgeManager({
    resolveTopic: async (uri) => ({ topicKey: uri.slice(-16).padStart(16, 'k'), topicName: `T · ${uri.slice(-16).padStart(16, 'k')}` }),
    computeCount: async () => 0,
    setBadge: (tabId, text) => badges.push([tabId, text]),
    onChange: (m) => persisted.push({ ...m }),
    ...over,
  })
  return { mgr, badges, persisted }
}

const KEY = 'k'.repeat(16)
const NAME = `T · ${KEY}`

describe('badgeManager.refreshTab', () => {
  test('null entity clears the badge', async () => {
    const { mgr, badges } = setup()
    await mgr.refreshTab(7, null)
    expect(badges).toEqual([[7, '']])
  })

  test('resolvable entity with no thread yet → empty badge', async () => {
    const { mgr, badges } = setup({ resolveTopic: async () => ({ topicKey: KEY, topicName: null }) })
    await mgr.refreshTab(7, 'web:x')
    expect(badges).toEqual([[7, '']])
  })

  test('resolved thread with unread count → number badge and cached', async () => {
    const { mgr, badges, persisted } = setup({
      resolveTopic: async () => ({ topicKey: KEY, topicName: NAME }),
      computeCount: async () => 4,
    })
    await mgr.refreshTab(7, 'web:x')
    expect(badges).toEqual([[7, '4']])
    expect(persisted.at(-1)).toEqual({ [KEY]: 4 })
  })

  test('resolved thread with zero unread → dot', async () => {
    const { mgr, badges } = setup({
      resolveTopic: async () => ({ topicKey: KEY, topicName: NAME }),
      computeCount: async () => 0,
    })
    await mgr.refreshTab(7, 'web:x')
    expect(badges).toEqual([[7, '•']])
  })

  test('unresolvable (null) → empty badge', async () => {
    const { mgr, badges } = setup({ resolveTopic: async () => null })
    await mgr.refreshTab(7, 'web:x')
    expect(badges).toEqual([[7, '']])
  })
})

describe('badgeManager events', () => {
  test('onMessageEvent increments the topic and repaints the active tab from cache', () => {
    const { mgr, persisted } = setup()
    mgr.setActiveTab(7)
    // active tab is showing NAME's topic
    mgr.onMessageEvent(NAME, false)
    expect(persisted.at(-1)![KEY]).toBe(1)
  })

  test('onMessageEvent from self does not increment', () => {
    const { mgr, persisted } = setup()
    mgr.onMessageEvent(NAME, true)
    expect(persisted).toEqual([])
  })

  test('onMessageEvent for a name with no key suffix is ignored', () => {
    const { mgr, persisted } = setup()
    mgr.onMessageEvent('no key', false)
    expect(persisted).toEqual([])
  })

  test('onMarkedRead zeroes the topic', () => {
    const { mgr, persisted } = setup()
    mgr.onMessageEvent(NAME, false)
    mgr.onMarkedRead(KEY)
    expect(persisted.at(-1)![KEY]).toBe(0)
  })

  test('seed restores a prior map so a later increment builds on it', () => {
    const { mgr, persisted } = setup()
    mgr.seed({ [KEY]: 5 })
    mgr.onMessageEvent(NAME, false)
    expect(persisted.at(-1)![KEY]).toBe(6)
  })
})

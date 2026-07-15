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

  test('unresolvable (null, transient) → badge left unchanged, not blanked', async () => {
    // resolveTopic returns null only on a transient failure (no creds loaded yet, network
    // error) — never "confirmed no thread". Blanking here would wipe a valid count on a
    // cold-start poll; the next successful poll re-resolves it.
    const { mgr, badges } = setup({ resolveTopic: async () => null })
    await mgr.refreshTab(7, 'web:x')
    expect(badges).toEqual([])
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

  test('refreshResolved uses the supplied topic name directly (no resolveTopic) and paints', async () => {
    const badges: Array<[number, string]> = []
    const calls: string[] = []
    const mgr = createBadgeManager({
      resolveTopic: async () => { calls.push('resolve'); return null },
      computeCount: async (name) => { calls.push('count:' + name); return 3 },
      setBadge: (tabId, text) => badges.push([tabId, text]),
      onChange: () => {},
    })
    mgr.setActiveTab(9)
    await mgr.refreshResolved(9, KEY, NAME)
    expect(calls).toEqual([`count:${NAME}`]) // resolveTopic NOT called
    expect(badges).toEqual([[9, '3']])
  })

  test('switching active tabs does not let an old-tab event repaint the new tab', async () => {
    const badges: Array<[number, string]> = []
    const mgr = createBadgeManager({
      resolveTopic: async () => ({ topicKey: KEY, topicName: NAME }),
      computeCount: async () => 0,
      setBadge: (tabId, text) => badges.push([tabId, text]),
      onChange: () => {},
    })
    mgr.setActiveTab(1)
    await mgr.refreshTab(1, 'web:a') // activeTopicKey = KEY for tab 1
    mgr.setActiveTab(2) // switch to tab 2 (its topic not yet resolved)
    badges.length = 0
    mgr.onMessageEvent(NAME, false) // event for tab 1's topic
    // tab 2's badge must NOT be painted with tab 1's topic count
    expect(badges).toEqual([])
  })
})

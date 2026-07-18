import { describe, expect, test } from 'vitest'
import type { PageEntity } from '../shared/messages'
import { headerMessage } from './headerMessage'

const entity = (over: Partial<PageEntity> = {}): PageEntity => ({
  entityUri: 'web:https://x.com/a',
  title: 'X Article',
  resolverId: 'web',
  resolverVersion: 1,
  ...over,
})

describe('headerMessage', () => {
  test('renders the §4.6 format, records resolver id@version, strips web: in the link', () => {
    expect(headerMessage(entity(), 'me@x.com')).toBe(
      [
        '🔗 Discussion for: X Article',
        'Entity: `web:https://x.com/a` (resolver web@1)',
        'Link: https://x.com/a',
        'Started by me@x.com',
      ].join('\n')
    )
  })

  test('sources the version from the entity, not a hardcoded literal', () => {
    expect(headerMessage(entity({ resolverVersion: 2 }), 'me@x.com')).toContain('(resolver web@2)')
  })
})

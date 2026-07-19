import { describe, expect, test } from 'vitest'
import { RESOLVER_ID, RESOLVER_VERSION, resolveWebEntity } from './resolver'

describe('resolveWebEntity', () => {
  test('prefixes the canonicalized URL with web: and tags the descriptor', () => {
    expect(resolveWebEntity('https://example.com/a', null)).toEqual({
      entityUri: 'web:https://example.com/a',
      resolverId: 'web',
      resolverVersion: 1,
    })
  })

  test('applies a canonical rule (keepParams) via canonicalize', () => {
    const r = resolveWebEntity('https://news.ycombinator.com/item?id=42&utm_source=x', null, {
      'news.ycombinator.com': { keepParams: ['id'] },
    })
    expect(r.entityUri).toBe('web:https://news.ycombinator.com/item?id=42')
  })

  test('exposes the resolver id and version constants', () => {
    expect(RESOLVER_ID).toBe('web')
    expect(RESOLVER_VERSION).toBe(1)
  })
})

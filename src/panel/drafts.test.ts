import { describe, expect, test } from 'vitest'
import { Drafts } from './drafts'

describe('Drafts', () => {
  test('get returns empty string for unknown uri', () => {
    expect(new Drafts().get('web:a')).toBe('')
  })

  test('set/get round-trips per uri independently', () => {
    const d = new Drafts()
    d.set('web:a', 'hello')
    d.set('web:b', 'other')
    expect(d.get('web:a')).toBe('hello')
    expect(d.get('web:b')).toBe('other')
  })

  test('setting empty text removes the entry; clear removes it too', () => {
    const d = new Drafts()
    d.set('web:a', 'hello')
    d.set('web:a', '')
    expect(d.get('web:a')).toBe('')
    d.set('web:b', 'x')
    d.clear('web:b')
    expect(d.get('web:b')).toBe('')
  })
})

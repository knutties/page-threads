import { describe, expect, test } from 'vitest'
import { splitLinks } from './linkify'

describe('splitLinks', () => {
  test('plain text yields one text segment', () => {
    expect(splitLinks('hello world')).toEqual([{ kind: 'text', value: 'hello world' }])
  })

  test('url in the middle yields text/link/text', () => {
    expect(splitLinks('see https://example.com/a?b=1 for details')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', value: 'https://example.com/a?b=1' },
      { kind: 'text', value: ' for details' },
    ])
  })

  test('bare url yields one link segment', () => {
    expect(splitLinks('http://localhost:9090/x')).toEqual([
      { kind: 'link', value: 'http://localhost:9090/x' },
    ])
  })

  test('multiple urls', () => {
    expect(splitLinks('a https://x.com b https://y.com')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'link', value: 'https://x.com' },
      { kind: 'text', value: ' b ' },
      { kind: 'link', value: 'https://y.com' },
    ])
  })

  test('empty string yields no segments', () => {
    expect(splitLinks('')).toEqual([])
  })
})

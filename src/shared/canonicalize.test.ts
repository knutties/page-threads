import { describe, expect, test } from 'vitest'
import { canonicalize } from './canonicalize'

describe('canonical link handling (spec §4.4 step 1)', () => {
  test('uses same-domain absolute canonical link as-is', () => {
    expect(
      canonicalize('https://example.com/article?page=2', 'https://example.com/article')
    ).toBe('https://example.com/article')
  })

  test('accepts canonical on a different subdomain of the same registrable domain', () => {
    expect(
      canonicalize('https://m.example.com/article', 'https://www.example.com/article')
    ).toBe('https://www.example.com/article')
  })

  test('rejects cross-domain canonical (syndication) and normalizes instead', () => {
    expect(
      canonicalize('https://syndicator.com/story/', 'https://original-publisher.com/story')
    ).toBe('https://syndicator.com/story')
  })

  test('rejects relative canonical (spec requires absolute)', () => {
    expect(canonicalize('https://example.com/a/', '/a')).toBe('https://example.com/a')
  })

  test('rejects non-http canonical', () => {
    expect(canonicalize('https://example.com/a', 'ftp://example.com/a')).toBe(
      'https://example.com/a'
    )
  })
})

describe('normalization (spec §4.4 step 2)', () => {
  test('lowercases scheme and host', () => {
    expect(canonicalize('HTTPS://EXAMPLE.COM/Path', null)).toBe('https://example.com/Path')
  })

  test('strips default ports', () => {
    expect(canonicalize('https://example.com:443/a', null)).toBe('https://example.com/a')
    expect(canonicalize('http://example.com:80/a', null)).toBe('http://example.com/a')
  })

  test('keeps non-default ports', () => {
    expect(canonicalize('http://localhost:9090/a', null)).toBe('http://localhost:9090/a')
  })

  test('strips trailing slash except on root', () => {
    expect(canonicalize('https://example.com/a/b/', null)).toBe('https://example.com/a/b')
    expect(canonicalize('https://example.com/', null)).toBe('https://example.com/')
    expect(canonicalize('https://example.com', null)).toBe('https://example.com/')
  })

  test('strips fragment', () => {
    expect(canonicalize('https://example.com/a#section-3', null)).toBe('https://example.com/a')
  })

  test('removes tracking params: utm_* prefix, exact names, vero_* prefix', () => {
    expect(
      canonicalize(
        'https://example.com/a?utm_source=x&utm_campaign=y&gclid=1&fbclid=2&mc_cid=3&mc_eid=4&igshid=5&ref=6&ref_src=7&_hsenc=8&_hsmi=9&vero_conv=10&yclid=11&msclkid=12',
        null
      )
    ).toBe('https://example.com/a')
  })

  test('keeps and sorts remaining params lexicographically', () => {
    expect(canonicalize('https://example.com/a?zeta=1&alpha=2&utm_source=x', null)).toBe(
      'https://example.com/a?alpha=2&zeta=1'
    )
  })

  test('tracking-param matching is case-insensitive', () => {
    expect(canonicalize('https://example.com/a?UTM_Source=x&id=5', null)).toBe(
      'https://example.com/a?id=5'
    )
  })
})

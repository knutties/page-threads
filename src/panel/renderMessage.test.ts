// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'
import { sanitizeMessageHtml } from './renderMessage'

const REALM = 'https://zulip.example.com'
const s = (html: string) => sanitizeMessageHtml(html, REALM)

describe('sanitizeMessageHtml — XSS corpus', () => {
  test.each([
    ['<script>alert(1)</script><p>hi</p>', 'script'],
    ['<style>*{display:none}</style><p>hi</p>', 'style'],
    ['<iframe src="https://evil.com"></iframe><p>hi</p>', 'iframe'],
    ['<form action="https://evil.com"><input></form><p>hi</p>', 'form'],
    ['<svg onload="alert(1)"></svg><p>hi</p>', 'svg'],
    ['<object data="x"></object><p>hi</p>', 'object'],
  ])('strips %s', (input, tag) => {
    const out = s(input)
    expect(out).not.toContain(`<${tag}`)
    expect(out).toContain('<p>hi</p>')
  })

  test('strips event handlers', () => {
    expect(s('<p onclick="alert(1)">hi</p>')).not.toContain('onclick')
  })

  test('javascript: href is removed', () => {
    const out = s('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('<a')
    expect(out).not.toContain('href=')
  })

  test('data: href is removed', () => {
    expect(s('<a href="data:text/html,x">x</a>')).not.toContain('href=')
  })
})

describe('sanitizeMessageHtml — images become click-to-load placeholders', () => {
  test('absolute remote image', () => {
    const out = s('<p><img src="https://cdn.example.com/x.png" alt="x"></p>')
    expect(out).not.toContain('<img')
    expect(out).toContain('class="img-placeholder"')
    expect(out).toContain('data-src="https://cdn.example.com/x.png"')
    expect(out).toContain('type="button"')
  })

  test('realm-relative upload resolves against the realm', () => {
    const out = s('<img src="/user_uploads/2/ab/x.png">')
    expect(out).toContain(`data-src="${REALM}/user_uploads/2/ab/x.png"`)
  })

  test('img with onerror produces a clean placeholder', () => {
    const out = s('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<img')
    expect(out).toContain('img-placeholder')
  })

  test('non-http image source yields placeholder without data-src', () => {
    const out = s('<img src="data:image/png;base64,AAAA">')
    expect(out).toContain('img-placeholder')
    expect(out).not.toContain('data-src')
  })
})

describe('sanitizeMessageHtml — Zulip markup passes', () => {
  test('mention spans, code blocks, quotes, tables survive', () => {
    const zulip =
      '<p><span class="user-mention" data-user-id="7">@Ada</span></p>' +
      '<blockquote><p>q</p></blockquote>' +
      '<div class="codehilite"><pre><code>x = 1</code></pre></div>' +
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>'
    const out = s(zulip)
    expect(out).toContain('user-mention')
    expect(out).toContain('<blockquote>')
    expect(out).toContain('<pre>')
    expect(out).toContain('<table>')
    expect(out).not.toContain('data-user-id') // attribute not allowlisted
  })

  test('links open safely in a new tab', () => {
    const out = s('<a href="https://example.com/x">x</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  test('realm-relative #narrow link becomes absolute', () => {
    const out = s('<a href="/#narrow/channel/4/topic/T">x</a>')
    expect(out).toContain(`href="${REALM}/#narrow/channel/4/topic/T"`)
  })
})

import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'p', 'div', 'span', 'a', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ol', 'ul', 'li', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'time', 'sup', 'sub', 'details', 'summary',
  'img', // never survives: transformed to a placeholder button below
]

const ALLOWED_ATTR = ['href', 'title', 'class', 'datetime', 'start', 'align', 'src']

/** Which attributes are valid on which tags (class is allowed on all). */
const ATTR_BY_TAG: Record<string, Set<string>> = {
  A: new Set(['href', 'title']),
  TIME: new Set(['datetime']),
  OL: new Set(['start']),
  TD: new Set(['align']),
  TH: new Set(['align']),
  IMG: new Set(['src']),
}

function resolveHttpUrl(raw: string, realmUrl: string): string | null {
  try {
    const u = new URL(raw, realmUrl)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/**
 * The single gate through which message HTML enters the DOM (spec §Rendering).
 * Zulip-rendered HTML in; sanitized HTML with click-to-load image placeholders out.
 * Two phases: DOMPurify with a strict allowlist, then a DOM transform pass that
 * (a) pins links to http(s) + new-tab + noopener, (b) rewrites every <img> to a
 * <button class="img-placeholder" data-src>. The transform only replaces nodes
 * with inert elements we construct, so it cannot reintroduce anything unsafe.
 */
export function sanitizeMessageHtml(html: string, realmUrl: string): string {
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName
    if (name === 'class') return // allowed on any allowlisted tag
    const allowed = ATTR_BY_TAG[node.tagName]
    if (!allowed || !allowed.has(name)) {
      data.keepAttr = false
    }
  })
  try {
    const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false })
    const tpl = document.createElement('template')
    tpl.innerHTML = clean
    for (const a of Array.from(tpl.content.querySelectorAll('a'))) {
      const abs = a.getAttribute('href') ? resolveHttpUrl(a.getAttribute('href')!, realmUrl) : null
      if (abs) a.setAttribute('href', abs)
      else a.removeAttribute('href')
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
    for (const img of Array.from(tpl.content.querySelectorAll('img'))) {
      const abs = img.getAttribute('src') ? resolveHttpUrl(img.getAttribute('src')!, realmUrl) : null
      const button = document.createElement('button')
      button.setAttribute('type', 'button')
      button.setAttribute('class', 'img-placeholder')
      if (abs) button.setAttribute('data-src', abs)
      button.textContent = '🖼️ Load image'
      img.replaceWith(button)
    }
    return tpl.innerHTML
  } finally {
    DOMPurify.removeAllHooks()
  }
}

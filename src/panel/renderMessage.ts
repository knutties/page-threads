import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'p', 'div', 'span', 'a', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ol', 'ul', 'li', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'time', 'sup', 'sub', 'details', 'summary',
  'img', // never emitted: rewritten to a placeholder button by the hook below
  'button', // only the placeholders we create ourselves
]

const ALLOWED_ATTR = ['href', 'title', 'class', 'datetime', 'start', 'align', 'src', 'data-src', 'type', 'target', 'rel']

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
 */
export function sanitizeMessageHtml(html: string, realmUrl: string): string {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href')
      const abs = href ? resolveHttpUrl(href, realmUrl) : null
      if (abs) node.setAttribute('href', abs)
      else node.removeAttribute('href')
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src')
      const abs = src ? resolveHttpUrl(src, realmUrl) : null
      const doc = node.ownerDocument
      const button = doc.createElement('button')
      button.setAttribute('type', 'button')
      button.setAttribute('class', 'img-placeholder')
      if (abs) button.setAttribute('data-src', abs)
      button.textContent = '🖼️ Load image'
      node.replaceWith(button)
    }
    if (node.tagName === 'BUTTON' && node.getAttribute('class') !== 'img-placeholder') {
      // The only buttons we allow are the placeholders we just created.
      node.remove()
    }
  })
  try {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR })
  } finally {
    DOMPurify.removeAllHooks()
  }
}

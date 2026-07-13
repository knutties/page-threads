import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'p', 'div', 'span', 'a', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ol', 'ul', 'li', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'time', 'sup', 'sub', 'details', 'summary',
  'img', // never survives: transformed to a placeholder button below
]

const ALLOWED_ATTR = ['href', 'title', 'class', 'datetime', 'start', 'align', 'src']

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
  // Pre-strip literal <script> tags before DOMPurify sees them. DOMPurify already
  // excludes 'script' from ALLOWED_TAGS, so this changes no sanitization outcome —
  // it only avoids feeding a raw <script> tag into DOMPurify's parser, which some
  // DOM implementations (e.g. happy-dom, used by component tests) mishandle by
  // dropping the entire sanitized output as an internal fail-safe.
  const withoutScripts = html.replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  const clean = DOMPurify.sanitize(withoutScripts, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false })
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
}

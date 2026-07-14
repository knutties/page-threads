import { getDomain } from 'tldts'
import type { CanonicalRule } from './ruleset'

const TRACKING_EXACT = new Set([
  'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src',
  '_hsenc', '_hsmi', 'yclid', 'msclkid',
])
const TRACKING_PREFIXES = ['utm_', 'vero_']

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase()
  return TRACKING_EXACT.has(k) || TRACKING_PREFIXES.some((p) => k.startsWith(p))
}

function acceptableCanonical(canonicalHref: string, pageHref: string): string | null {
  if (!/^https?:\/\//i.test(canonicalHref)) return null // must be absolute http(s)
  try {
    const c = new URL(canonicalHref)
    const page = new URL(pageHref)
    const cDomain = getDomain(c.hostname)
    const pDomain = getDomain(page.hostname)
    if (cDomain === null || pDomain === null || cDomain !== pDomain) return null
    return c.href
  } catch {
    return null
  }
}

/** Spec §4.4 step 3: per-domain keepParams narrowing + pathRewrite. Pure; no-op when no rule matches. */
function applyDomainRules(url: string, canonical: Record<string, CanonicalRule>): string {
  const u = new URL(url)
  const pageReg = getDomain(u.hostname) ?? u.hostname
  // Match rule keys by registrable domain — the SAME notion isBlocked uses — so a
  // domain string means the same thing in `canonical` and `blocked`. A key like
  // "news.ycombinator.com" therefore applies to the whole ycombinator.com family.
  let rule: CanonicalRule | undefined
  for (const [key, r] of Object.entries(canonical)) {
    if ((getDomain(key) ?? key) === pageReg) {
      rule = r
      break
    }
  }
  if (!rule) return url
  if (rule.pathRewrite !== undefined) u.pathname = rule.pathRewrite
  if (rule.keepParams !== undefined) {
    const keep = new Set(rule.keepParams)
    const sp = new URLSearchParams()
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (keep.has(k)) sp.append(k, v)
    }
    u.search = sp.toString()
  }
  return u.origin + u.pathname + (u.search ? u.search : '')
}

/** Spec §4.4 steps 1–2: canonical-link check, else URL normalization. */
export function canonicalize(
  href: string,
  canonicalHref: string | null,
  canonical?: Record<string, CanonicalRule>
): string {
  if (canonicalHref) {
    const accepted = acceptableCanonical(canonicalHref, href)
    if (accepted !== null) return accepted
  }

  const u = new URL(href) // lowercases scheme+host, strips default ports
  u.hash = ''
  if (u.pathname !== '/' && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '')
  }
  const kept = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k))
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const sp = new URLSearchParams()
  for (const [k, v] of kept) sp.append(k, v)
  const q = sp.toString()
  const normalized = u.origin + u.pathname + (q ? `?${q}` : '')
  return canonical ? applyDomainRules(normalized, canonical) : normalized
}

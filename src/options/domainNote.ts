import { getDomain } from 'tldts'

/**
 * A non-blocking note when `domain` isn't its own registrable domain — matching
 * collapses subdomains to the registrable domain (same notion isBlocked/canonicalize
 * use), so blocking/keying mail.example.com actually affects all of example.com.
 * Returns null when the input already IS its registrable domain, or won't parse.
 */
export function registrableNote(domain: string): string | null {
  const d = domain.trim()
  const reg = getDomain(d)
  return reg && reg !== d
    ? `This affects all of ${reg} (subdomains collapse to the registrable domain).`
    : null
}

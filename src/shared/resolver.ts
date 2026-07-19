import { canonicalize } from './canonicalize'
import type { CanonicalRule } from './ruleset'

export const RESOLVER_ID = 'web'
/**
 * The §4.4 web-canonicalization algorithm version. Bump this DELIBERATELY when the
 * algorithm changes in a way that re-keys existing threads (a versioned act per §4.5)
 * — never automatically.
 */
export const RESOLVER_VERSION = 1

export interface ResolvedEntity {
  entityUri: string
  resolverId: string
  resolverVersion: number
}

/** The generic web resolver (§4.4): canonicalize, prefix with `web:`, tag with the descriptor. */
export function resolveWebEntity(
  href: string,
  canonicalHref: string | null,
  canonicalRules?: Record<string, CanonicalRule>
): ResolvedEntity {
  return {
    entityUri: 'web:' + canonicalize(href, canonicalHref, canonicalRules),
    resolverId: RESOLVER_ID,
    resolverVersion: RESOLVER_VERSION,
  }
}

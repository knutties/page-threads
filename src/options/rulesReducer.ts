import type { CanonicalRule, Ruleset } from '../shared/ruleset'

export type RulesAction =
  | { type: 'addDomain'; domain: string }
  | { type: 'removeDomain'; domain: string }
  | { type: 'setKeepParams'; domain: string; keepParams: string[] }
  | { type: 'setPathRewrite'; domain: string; pathRewrite: string }
  | { type: 'addBlocked'; domain: string }
  | { type: 'removeBlocked'; domain: string }

export function parseKeepParams(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function withCanonical(rs: Ruleset, domain: string, rule: CanonicalRule): Ruleset {
  return { ...rs, canonical: { ...rs.canonical, [domain]: rule } }
}

export function rulesReducer(rs: Ruleset, action: RulesAction): Ruleset {
  switch (action.type) {
    case 'addDomain':
      if (rs.canonical[action.domain]) return rs
      return withCanonical(rs, action.domain, {})
    case 'removeDomain': {
      const next = { ...rs.canonical }
      delete next[action.domain]
      return { ...rs, canonical: next }
    }
    case 'setKeepParams': {
      const rule = { ...(rs.canonical[action.domain] ?? {}) }
      if (action.keepParams.length) rule.keepParams = action.keepParams
      else delete rule.keepParams
      return withCanonical(rs, action.domain, rule)
    }
    case 'setPathRewrite': {
      const rule = { ...(rs.canonical[action.domain] ?? {}) }
      if (action.pathRewrite) rule.pathRewrite = action.pathRewrite
      else delete rule.pathRewrite
      return withCanonical(rs, action.domain, rule)
    }
    case 'addBlocked':
      if (rs.blocked.includes(action.domain)) return rs
      return { ...rs, blocked: [...rs.blocked, action.domain] }
    case 'removeBlocked':
      return { ...rs, blocked: rs.blocked.filter((d) => d !== action.domain) }
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

export function validateRuleset(
  raw: unknown
): { ok: true; value: Ruleset } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'canonical must be an object.' }
  }
  const obj = raw as Record<string, unknown>
  const canonicalRaw = obj.canonical ?? {}
  if (typeof canonicalRaw !== 'object' || canonicalRaw === null || Array.isArray(canonicalRaw)) {
    return { ok: false, error: 'canonical must be an object.' }
  }
  const canonical: Record<string, CanonicalRule> = {}
  for (const [domain, ruleRaw] of Object.entries(canonicalRaw as Record<string, unknown>)) {
    if (typeof ruleRaw !== 'object' || ruleRaw === null || Array.isArray(ruleRaw)) {
      return { ok: false, error: `rule for ${domain} must be an object.` }
    }
    const rule = ruleRaw as Record<string, unknown>
    const out: CanonicalRule = {}
    if (rule.keepParams !== undefined) {
      if (!isStringArray(rule.keepParams)) {
        return { ok: false, error: `keepParams must be an array of strings (${domain}).` }
      }
      out.keepParams = rule.keepParams
    }
    if (rule.pathRewrite !== undefined) {
      if (typeof rule.pathRewrite !== 'string') {
        return { ok: false, error: `pathRewrite must be a string (${domain}).` }
      }
      out.pathRewrite = rule.pathRewrite
    }
    canonical[domain] = out
  }
  const blockedRaw = obj.blocked ?? []
  if (!isStringArray(blockedRaw)) {
    return { ok: false, error: 'blocked must be an array of strings.' }
  }
  return { ok: true, value: { canonical, blocked: blockedRaw } }
}

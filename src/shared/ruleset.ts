import { getDomain } from 'tldts'
import { createStore, type StorageAreaLike, type StorageChangedLike, type Store } from './storage'

export interface CanonicalRule {
  keepParams?: string[]
  pathRewrite?: string
}

export interface Ruleset {
  canonical: Record<string, CanonicalRule>
  blocked: string[]
}

/** Blocked defaults are illustrative examples, not an exhaustive privacy guarantee (spec §7). */
export const DEFAULT_RULESET: Ruleset = {
  canonical: {},
  blocked: ['examplebank.com', 'examplehealth.com'],
}

export function createRulesetStore(
  area: StorageAreaLike = chrome.storage.sync,
  changed: StorageChangedLike = chrome.storage.onChanged,
  areaName = 'sync'
): Store<Ruleset> {
  return createStore('ruleset', DEFAULT_RULESET, area, changed, areaName)
}

/** True when `domain`'s registrable domain is in the block-list (matches the domain or any subdomain). */
export function isBlocked(domain: string, blocked: string[]): boolean {
  const registrable = getDomain(domain) ?? domain
  return blocked.some((b) => {
    const bReg = getDomain(b) ?? b
    return bReg === registrable
  })
}

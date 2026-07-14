import { describe, expect, test } from 'vitest'
import { parseKeepParams, rulesReducer, validateRuleset } from './rulesReducer'
import type { Ruleset } from '../shared/ruleset'

const empty: Ruleset = { canonical: {}, blocked: [] }

describe('rulesReducer', () => {
  test('addDomain creates an empty rule; removeDomain deletes it', () => {
    const a = rulesReducer(empty, { type: 'addDomain', domain: 'x.com' })
    expect(a.canonical).toEqual({ 'x.com': {} })
    const b = rulesReducer(a, { type: 'removeDomain', domain: 'x.com' })
    expect(b.canonical).toEqual({})
  })

  test('addDomain on an existing domain is a no-op (keeps its rule)', () => {
    const a: Ruleset = { canonical: { 'x.com': { keepParams: ['id'] } }, blocked: [] }
    expect(rulesReducer(a, { type: 'addDomain', domain: 'x.com' }).canonical['x.com']).toEqual({
      keepParams: ['id'],
    })
  })

  test('setKeepParams / setPathRewrite update the domain rule', () => {
    let rs = rulesReducer(empty, { type: 'addDomain', domain: 'x.com' })
    rs = rulesReducer(rs, { type: 'setKeepParams', domain: 'x.com', keepParams: ['id', 'v'] })
    rs = rulesReducer(rs, { type: 'setPathRewrite', domain: 'x.com', pathRewrite: '/w' })
    expect(rs.canonical['x.com']).toEqual({ keepParams: ['id', 'v'], pathRewrite: '/w' })
  })

  test('setKeepParams with an empty array removes the keepParams field', () => {
    let rs: Ruleset = { canonical: { 'x.com': { keepParams: ['id'] } }, blocked: [] }
    rs = rulesReducer(rs, { type: 'setKeepParams', domain: 'x.com', keepParams: [] })
    expect(rs.canonical['x.com']).toEqual({})
  })

  test('setPathRewrite with empty string removes the pathRewrite field', () => {
    let rs: Ruleset = { canonical: { 'x.com': { pathRewrite: '/w' } }, blocked: [] }
    rs = rulesReducer(rs, { type: 'setPathRewrite', domain: 'x.com', pathRewrite: '' })
    expect(rs.canonical['x.com']).toEqual({})
  })

  test('addBlocked / removeBlocked; addBlocked dedupes', () => {
    let rs = rulesReducer(empty, { type: 'addBlocked', domain: 'a.com' })
    rs = rulesReducer(rs, { type: 'addBlocked', domain: 'a.com' })
    expect(rs.blocked).toEqual(['a.com'])
    rs = rulesReducer(rs, { type: 'removeBlocked', domain: 'a.com' })
    expect(rs.blocked).toEqual([])
  })
})

describe('parseKeepParams', () => {
  test('splits, trims, drops empties', () => {
    expect(parseKeepParams(' id , v ,, ')).toEqual(['id', 'v'])
    expect(parseKeepParams('   ')).toEqual([])
  })
})

describe('validateRuleset', () => {
  test('accepts a well-formed ruleset', () => {
    const r = validateRuleset({ canonical: { 'x.com': { keepParams: ['id'], pathRewrite: '/w' } }, blocked: ['a.com'] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.canonical['x.com'].keepParams).toEqual(['id'])
  })

  test('accepts a bare {} by filling defaults', () => {
    const r = validateRuleset({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ canonical: {}, blocked: [] })
  })

  test.each([
    ['not an object', 'canonical must be an object'],
    [{ canonical: [], blocked: [] }, 'canonical must be an object'],
    [{ canonical: {}, blocked: 'a.com' }, 'blocked must be an array of strings'],
    [{ canonical: { 'x.com': { keepParams: 'id' } }, blocked: [] }, 'keepParams must be an array of strings'],
    [{ canonical: { 'x.com': { pathRewrite: 3 } }, blocked: [] }, 'pathRewrite must be a string'],
  ])('rejects %s', (input, msg) => {
    const r = validateRuleset(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(msg)
  })
})

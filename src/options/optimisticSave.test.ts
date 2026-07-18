import { describe, expect, test, vi } from 'vitest'
import { optimisticSave } from './optimisticSave'

describe('optimisticSave', () => {
  test('applies optimistically then onSuccess on success, without reloading or reverting', async () => {
    const calls: string[] = []
    const reload = vi.fn(async () => 'RELOADED')
    await optimisticSave({
      applyOptimistic: () => calls.push('apply'),
      persist: async () => {},
      reload,
      revert: () => calls.push('revert'),
      onSuccess: () => calls.push('success'),
      onError: () => calls.push('error'),
    })
    expect(calls).toEqual(['apply', 'success'])
    expect(reload).not.toHaveBeenCalled()
  })

  test('on save failure reverts to reloaded store truth and reports the error', async () => {
    const calls: string[] = []
    let reverted: string | null = null
    await optimisticSave<string>({
      applyOptimistic: () => calls.push('apply'),
      persist: async () => {
        throw new Error('quota')
      },
      reload: async () => 'TRUTH',
      revert: (t) => {
        reverted = t
        calls.push('revert')
      },
      onSuccess: () => calls.push('success'),
      onError: () => calls.push('error'),
    })
    expect(calls).toEqual(['apply', 'revert', 'error'])
    expect(reverted).toBe('TRUTH')
  })

  test('revert reflects the CURRENT store, not a stale pre-edit value', async () => {
    let truth = 'S0'
    let reverted: string | null = null
    await optimisticSave<string>({
      applyOptimistic: () => {},
      persist: async () => {
        truth = 'B' // a concurrent edit B won the store before A's save rejected
        throw new Error('A failed')
      },
      reload: async () => truth,
      revert: (t) => {
        reverted = t
      },
      onSuccess: () => {},
      onError: () => {},
    })
    expect(reverted).toBe('B') // not 'S0'
  })

  test('if BOTH persist and reload fail, onError still fires (banner shows), no unhandled throw', async () => {
    const calls: string[] = []
    await optimisticSave<string>({
      applyOptimistic: () => calls.push('apply'),
      persist: async () => {
        throw new Error('save failed')
      },
      reload: async () => {
        throw new Error('reload failed too')
      },
      revert: () => calls.push('revert'),
      onSuccess: () => calls.push('success'),
      onError: () => calls.push('error'),
    })
    expect(calls).toEqual(['apply', 'error']) // revert skipped (reload threw), but onError still called
  })
})

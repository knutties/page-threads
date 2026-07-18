import { describe, expect, test, vi } from 'vitest'
import { optimisticSave } from './optimisticSave'

describe('optimisticSave', () => {
  test('applies optimistically then onSuccess on success, without reloading', async () => {
    const apply = vi.fn()
    const reload = vi.fn(async () => 'RELOADED')
    const onSuccess = vi.fn()
    const onError = vi.fn()
    await optimisticSave({ next: 'NEXT', apply, persist: async () => {}, reload, onSuccess, onError })
    expect(apply.mock.calls).toEqual([['NEXT']])
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  test('on save failure reverts to reloaded store truth and reports the error', async () => {
    const applied: string[] = []
    const onSuccess = vi.fn()
    const onError = vi.fn()
    await optimisticSave({
      next: 'NEXT',
      apply: (v) => applied.push(v),
      persist: async () => {
        throw new Error('quota')
      },
      reload: async () => 'TRUTH',
      onSuccess,
      onError,
    })
    expect(applied).toEqual(['NEXT', 'TRUTH']) // optimistic, then reverted to store truth (not a stale snapshot)
    expect(onError).toHaveBeenCalledWith('Could not save — try again.')
    expect(onSuccess).not.toHaveBeenCalled()
  })

  test('revert reflects the CURRENT store, not the pre-edit value (stale-revert gone)', async () => {
    let truth = 'S0'
    const applied: string[] = []
    await optimisticSave({
      next: 'A',
      apply: (v) => applied.push(v),
      persist: async () => {
        truth = 'B' // a concurrent edit B won the store before A's save rejected
        throw new Error('A failed')
      },
      reload: async () => truth,
      onSuccess: () => {},
      onError: () => {},
    })
    expect(applied).toEqual(['A', 'B']) // NOT ['A', 'S0'] — no revert to a stale pre-edit snapshot
  })
})

/**
 * Optimistic write with revert-to-store-truth. Runs the caller's optimistic
 * update, then persists; on success clears the error via onSuccess; on failure
 * re-reads the store (serialized source of truth) and reverts to it — never a
 * stale in-memory snapshot, so a rejected earlier save can't discard a later
 * edit. applyOptimistic is a thunk so callers can use a functional setState
 * (building on the latest committed state under rapid edits). If reload itself
 * rejects, the error is still reported.
 */
export async function optimisticSave<T>(deps: {
  applyOptimistic: () => void
  persist: () => Promise<void>
  reload: () => Promise<T>
  revert: (truth: T) => void
  onSuccess: () => void
  onError: (message: string) => void
}): Promise<void> {
  deps.applyOptimistic()
  try {
    await deps.persist()
    deps.onSuccess()
  } catch {
    try {
      deps.revert(await deps.reload())
    } catch {
      // reload also failed — keep the optimistic value on screen; still report below.
    }
    deps.onError('Could not save — try again.')
  }
}

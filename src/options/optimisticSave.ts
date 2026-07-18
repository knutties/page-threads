/**
 * Optimistic write with revert-to-store-truth. Applies `next` immediately, then
 * persists; on success clears the error via onSuccess; on failure re-reads the
 * store (the serialized source of truth) and applies that — never a stale
 * in-memory snapshot, so a rejected earlier save can't discard a later edit.
 */
export async function optimisticSave<T>(deps: {
  next: T
  apply: (value: T) => void
  persist: (value: T) => Promise<void>
  reload: () => Promise<T>
  onSuccess: () => void
  onError: (message: string) => void
}): Promise<void> {
  deps.apply(deps.next)
  try {
    await deps.persist(deps.next)
    deps.onSuccess()
  } catch {
    deps.apply(await deps.reload())
    deps.onError('Could not save — try again.')
  }
}

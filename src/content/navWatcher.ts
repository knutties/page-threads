export interface NavWatcherOptions {
  /** Re-resolve the current page to an entityUri. */
  resolve: () => string
  /** Called only when the resolved uri differs from the last known one. */
  onChange: (entityUri: string) => void
  debounceMs?: number
}

/**
 * Debounces navigation signals (popstate, Navigation API, title mutations,
 * href polling) and emits only on real entity changes.
 */
export function createNavWatcher(opts: NavWatcherOptions): {
  trigger: () => void
  seed: (uri: string) => void
} {
  const debounceMs = opts.debounceMs ?? 150
  let last: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  return {
    seed(uri) {
      last = uri
    },
    trigger() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        const uri = opts.resolve()
        if (uri !== last) {
          last = uri
          opts.onChange(uri)
        }
      }, debounceMs)
    },
  }
}

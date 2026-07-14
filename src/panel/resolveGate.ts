/** True when the panel must wait for an explicit "Check for discussion" click before resolving. */
export function shouldGate(resolveMode: 'auto' | 'manual'): boolean {
  return resolveMode === 'manual'
}

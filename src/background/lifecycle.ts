import type { Credentials } from '../shared/credentials'

export interface LoopLike {
  start(): Promise<void>
  stop(): void
}

/**
 * Owns the (credentials × ports) → event-loop state machine, extracted from
 * the service worker so it is unit-testable (M1c backlog #2).
 */
export function createLifecycle(deps: {
  loadCredentials(): Promise<Credentials | null>
  makeLoop(creds: Credentials): LoopLike
}) {
  let credentials: Credentials | null = null
  let loop: LoopLike | null = null
  let ports = 0

  function evaluate(): void {
    if (loop || !credentials || ports === 0) return
    loop = deps.makeLoop(credentials)
    void loop.start()
  }

  function restart(): void {
    loop?.stop()
    loop = null
    evaluate()
  }

  return {
    async init() {
      credentials = await deps.loadCredentials()
      evaluate()
    },
    async reloadCredentials() {
      credentials = await deps.loadCredentials()
      restart()
    },
    setCredentials(c: Credentials | null) {
      credentials = c
      restart()
    },
    portConnected() {
      ports++
      evaluate()
    },
    portDisconnected() {
      ports--
      if (ports === 0) {
        loop?.stop()
        loop = null
      }
    },
  }
}

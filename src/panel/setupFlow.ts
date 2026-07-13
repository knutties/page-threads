export interface ServerInfo {
  passwordAuthEnabled: boolean
  realmName: string
}

export type AuthTab = 'password' | 'apikey'

export interface SetupState {
  step: 'realm' | 'auth'
  realmUrl: string
  serverInfo: ServerInfo | null
  authTab: AuthTab
  busy: boolean
  error: string | null
}

export const INITIAL_SETUP: SetupState = {
  step: 'realm',
  realmUrl: '',
  serverInfo: null,
  authTab: 'apikey',
  busy: false,
  error: null,
}

export type SetupEvent =
  | { type: 'probeStarted' }
  | { type: 'probeOk'; realmUrl: string; serverInfo: ServerInfo }
  | { type: 'probeFailed'; message: string }
  | { type: 'tabChanged'; tab: AuthTab }
  | { type: 'authStarted' }
  | { type: 'authFailed'; message: string }
  | { type: 'back' }

/** Pure state machine for SetupView. Auth success is terminal (component unmounts). */
export function setupReducer(state: SetupState, event: SetupEvent): SetupState {
  switch (event.type) {
    case 'probeStarted':
      return { ...state, busy: true, error: null }
    case 'probeOk':
      return {
        ...state,
        step: 'auth',
        realmUrl: event.realmUrl,
        serverInfo: event.serverInfo,
        authTab: event.serverInfo.passwordAuthEnabled ? 'password' : 'apikey',
        busy: false,
        error: null,
      }
    case 'probeFailed':
      return { ...state, step: 'realm', busy: false, error: event.message }
    case 'tabChanged':
      return { ...state, authTab: event.tab, error: null }
    case 'authStarted':
      return { ...state, busy: true, error: null }
    case 'authFailed':
      return { ...state, busy: false, error: event.message }
    case 'back':
      return { ...state, step: 'realm', busy: false, error: null }
  }
}

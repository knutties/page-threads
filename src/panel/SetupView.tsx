import { useReducer, useState } from 'preact/hooks'
import { normalizeRealmUrl, type Credentials } from '../shared/credentials'
import { ZulipClient } from '../shared/zulipClient'
import { INITIAL_SETUP, setupReducer, type ServerInfo } from './setupFlow'

export interface SetupApi {
  probe(realmUrl: string): Promise<ServerInfo>
  fetchApiKey(realmUrl: string, email: string, password: string): Promise<string>
  /** Throws Error with a user-facing message when credentials or channel are bad. */
  validate(creds: Credentials): Promise<void>
}

export const defaultSetupApi: SetupApi = {
  probe: async (realmUrl) => {
    const s = await ZulipClient.probeServer(realmUrl)
    return { passwordAuthEnabled: s.passwordAuthEnabled, realmName: s.realmName }
  },
  fetchApiKey: (realmUrl, email, password) => ZulipClient.fetchApiKey(realmUrl, email, password),
  validate: async (creds) => {
    const client = new ZulipClient(creds)
    try {
      await client.getOwnUser()
    } catch {
      throw new Error('Zulip rejected these credentials. Check the email and API key.')
    }
    try {
      await client.getStreamId(creds.channelName)
    } catch {
      throw new Error(
        `Channel #${creds.channelName} doesn't exist on this realm. Ask your Zulip admin to create it, then try again.`
      )
    }
  },
}

export function SetupView({ onComplete, api = defaultSetupApi }: { onComplete: (c: Credentials) => void; api?: SetupApi }) {
  const [state, dispatch] = useReducer(setupReducer, INITIAL_SETUP)
  const [realmInput, setRealmInput] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [channelName, setChannelName] = useState('web-threads')

  async function submitRealm(e: Event) {
    e.preventDefault()
    const normalized = normalizeRealmUrl(realmInput)
    if (!normalized) {
      dispatch({ type: 'probeFailed', message: 'Enter a valid realm URL (https://your-org.zulipchat.com).' })
      return
    }
    dispatch({ type: 'probeStarted' })
    try {
      const serverInfo = await api.probe(normalized)
      dispatch({ type: 'probeOk', realmUrl: normalized, serverInfo })
    } catch (err) {
      const hint =
        normalized.startsWith('https://') && err instanceof TypeError
          ? ' If this realm uses a self-signed certificate, open it in a tab and accept the warning first.'
          : ''
      dispatch({ type: 'probeFailed', message: errText(err) + hint })
    }
  }

  async function submitAuth(e: Event) {
    e.preventDefault()
    dispatch({ type: 'authStarted' })
    try {
      const key =
        state.authTab === 'password' ? await api.fetchApiKey(state.realmUrl, email.trim(), password) : apiKey.trim()
      const creds: Credentials = {
        realmUrl: state.realmUrl,
        email: email.trim(),
        apiKey: key,
        channelName: channelName.trim() || 'web-threads',
      }
      await api.validate(creds)
      setPassword('') // never keep the password around
      onComplete(creds)
    } catch (err) {
      dispatch({ type: 'authFailed', message: errText(err) })
    }
  }

  if (state.step === 'realm') {
    return (
      <form class="setup" onSubmit={(e) => void submitRealm(e)}>
        <h2>Connect to Zulip</h2>
        <p>PageThreads stores page discussions in a Zulip realm.</p>
        <label>
          Realm URL
          <input
            type="text"
            placeholder="https://your-org.zulipchat.com"
            value={realmInput}
            onInput={(e) => setRealmInput((e.target as HTMLInputElement).value)}
            disabled={state.busy}
          />
        </label>
        {state.error && <div class="error">{state.error}</div>}
        <button type="submit" disabled={state.busy}>
          {state.busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
    )
  }

  return (
    <form class="setup" onSubmit={(e) => void submitAuth(e)}>
      <h2>{state.serverInfo?.realmName || state.realmUrl}</h2>
      <p>
        {state.realmUrl}{' '}
        <button type="button" class="linkish" onClick={() => dispatch({ type: 'back' })} disabled={state.busy}>
          Change
        </button>
      </p>
      <div class="tabs">
        {state.serverInfo?.passwordAuthEnabled && (
          <button
            type="button"
            class={state.authTab === 'password' ? 'tab active' : 'tab'}
            onClick={() => dispatch({ type: 'tabChanged', tab: 'password' })}
          >
            Sign in
          </button>
        )}
        <button
          type="button"
          class={state.authTab === 'apikey' ? 'tab active' : 'tab'}
          onClick={() => dispatch({ type: 'tabChanged', tab: 'apikey' })}
        >
          API key
        </button>
      </div>
      <label>
        Email
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          disabled={state.busy}
        />
      </label>
      {state.authTab === 'password' ? (
        <label>
          Password
          <input
            type="password"
            placeholder="Password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            disabled={state.busy}
          />
        </label>
      ) : (
        <label>
          API key <small>(Zulip → Personal settings → Account &amp; privacy)</small>
          <input
            type="password"
            placeholder="API key"
            value={apiKey}
            onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
            disabled={state.busy}
          />
        </label>
      )}
      <label>
        Channel
        <input
          type="text"
          value={channelName}
          onInput={(e) => setChannelName((e.target as HTMLInputElement).value)}
          disabled={state.busy}
        />
      </label>
      {state.error && <div class="error">{state.error}</div>}
      <button type="submit" disabled={state.busy}>
        {state.busy ? 'Connecting…' : state.authTab === 'password' ? 'Sign in' : 'Save'}
      </button>
    </form>
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

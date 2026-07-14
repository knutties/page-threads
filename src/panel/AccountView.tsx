import type { Credentials } from '../shared/credentials'

export function AccountView({
  credentials,
  fullName,
  onClose,
  onSignOut,
}: {
  credentials: Credentials
  fullName?: string
  onClose: () => void
  onSignOut: () => void
}) {
  return (
    <div class="account">
      <header>
        <span class="title">Account</span>
        <button aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      <dl>
        <dt>Realm</dt>
        <dd>{credentials.realmUrl}</dd>
        <dt>Signed in as</dt>
        <dd>{fullName ? `${fullName} (${credentials.email})` : credentials.email}</dd>
        <dt>Channel</dt>
        <dd>#{credentials.channelName}</dd>
      </dl>
      <button onClick={() => chrome.runtime.openOptionsPage()}>Settings</button>
      <button class="danger" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  )
}

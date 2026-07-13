// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, test, vi } from 'vitest'
import { AccountView } from './AccountView'

const CREDS = { realmUrl: 'https://a.com', email: 'me@x.com', apiKey: 'k', channelName: 'web-threads' }

describe('AccountView', () => {
  test('shows realm, identity, and channel', () => {
    render(<AccountView credentials={CREDS} fullName="Me Myself" onClose={() => {}} onSignOut={() => {}} />)
    expect(screen.getByText('https://a.com')).toBeTruthy()
    expect(screen.getByText(/Me Myself/)).toBeTruthy()
    expect(screen.getByText(/me@x\.com/)).toBeTruthy()
    expect(screen.getByText('#web-threads')).toBeTruthy()
  })

  test('sign out and close fire callbacks', () => {
    const onSignOut = vi.fn()
    const onClose = vi.fn()
    render(<AccountView credentials={CREDS} onClose={onClose} onSignOut={onSignOut} />)
    fireEvent.click(screen.getByText('Sign out'))
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onSignOut).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, test, vi } from 'vitest'
import type { Credentials } from '../shared/credentials'
import { SetupView, type SetupApi } from './SetupView'

function api(overrides: Partial<SetupApi> = {}): SetupApi {
  return {
    probe: async () => ({ passwordAuthEnabled: true, realmName: 'Acme' }),
    fetchApiKey: async () => 'fetched-key',
    validate: async () => {},
    ...overrides,
  }
}

async function toAuthStep(realm = 'acme.zulipchat.com') {
  fireEvent.input(screen.getByPlaceholderText('https://your-org.zulipchat.com'), { target: { value: realm } })
  fireEvent.submit(screen.getByPlaceholderText('https://your-org.zulipchat.com').closest('form')!)
  await waitFor(() => expect(screen.getByText('Sign in', { selector: 'button.tab' })).toBeTruthy())
}

describe('SetupView', () => {
  test('happy path via password tab completes with fetched key and normalized realm', async () => {
    const onComplete = vi.fn()
    render(<SetupView onComplete={onComplete} api={api()} />)
    await toAuthStep()
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), { target: { value: 'me@x.com' } })
    fireEvent.input(screen.getByPlaceholderText('Password'), { target: { value: 'hunter2' } })
    fireEvent.submit(screen.getByPlaceholderText('Password').closest('form')!)
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    const creds: Credentials = onComplete.mock.calls[0][0]
    expect(creds).toEqual({
      realmUrl: 'https://acme.zulipchat.com',
      email: 'me@x.com',
      apiKey: 'fetched-key',
      channelName: 'web-threads',
    })
  })

  test('happy path via API-key tab', async () => {
    const onComplete = vi.fn()
    render(<SetupView onComplete={onComplete} api={api()} />)
    await toAuthStep()
    fireEvent.click(screen.getByText('API key'))
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), { target: { value: 'me@x.com' } })
    fireEvent.input(screen.getByPlaceholderText('API key'), { target: { value: ' pasted-key ' } })
    fireEvent.submit(screen.getByPlaceholderText('API key').closest('form')!)
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    expect(onComplete.mock.calls[0][0].apiKey).toBe('pasted-key')
  })

  test('invalid realm input shows validation error without calling probe', async () => {
    const probe = vi.fn()
    render(<SetupView onComplete={() => {}} api={api({ probe })} />)
    fireEvent.input(screen.getByPlaceholderText('https://your-org.zulipchat.com'), { target: { value: 'http://not-local.example' } })
    fireEvent.submit(screen.getByPlaceholderText('https://your-org.zulipchat.com').closest('form')!)
    await waitFor(() => expect(screen.getByText(/valid realm URL/)).toBeTruthy())
    expect(probe).not.toHaveBeenCalled()
  })

  test('probe failure surfaces the error on the realm step', async () => {
    render(
      <SetupView onComplete={() => {}} api={api({ probe: async () => Promise.reject(new Error('unreachable')) })} />
    )
    fireEvent.input(screen.getByPlaceholderText('https://your-org.zulipchat.com'), { target: { value: 'acme.zulipchat.com' } })
    fireEvent.submit(screen.getByPlaceholderText('https://your-org.zulipchat.com').closest('form')!)
    await waitFor(() => expect(screen.getByText(/unreachable/)).toBeTruthy())
  })

  test('validate failure (e.g. channel missing) keeps auth step with message; password field cleared after failed submit too', async () => {
    render(
      <SetupView
        onComplete={() => {}}
        api={api({ validate: async () => Promise.reject(new Error("Channel #web-threads doesn't exist")) })}
      />
    )
    await toAuthStep()
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), { target: { value: 'me@x.com' } })
    fireEvent.input(screen.getByPlaceholderText('Password'), { target: { value: 'hunter2' } })
    fireEvent.submit(screen.getByPlaceholderText('Password').closest('form')!)
    await waitFor(() => expect(screen.getByText(/doesn't exist/)).toBeTruthy())
  })

  test('hides the Sign in tab when the realm has no password auth', async () => {
    render(
      <SetupView onComplete={() => {}} api={api({ probe: async () => ({ passwordAuthEnabled: false, realmName: 'A' }) })} />
    )
    fireEvent.input(screen.getByPlaceholderText('https://your-org.zulipchat.com'), { target: { value: 'acme.zulipchat.com' } })
    fireEvent.submit(screen.getByPlaceholderText('https://your-org.zulipchat.com').closest('form')!)
    await waitFor(() => expect(screen.getByPlaceholderText('API key')).toBeTruthy())
    expect(screen.queryByText('Sign in', { selector: 'button.tab' })).toBeNull()
    expect(screen.getByPlaceholderText('API key')).toBeTruthy()
  })
})

// @vitest-environment happy-dom
import { render, screen } from '@testing-library/preact'
import { describe, expect, test } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { ThreadView } from './ThreadView'

function msg(id: number, content: string): ZulipMessage {
  return { id, sender_full_name: 'Ada', sender_email: 'ada@x.com', content, timestamp: 1700000000, subject: 'T · k' }
}

describe('ThreadView', () => {
  test('shows empty state when no thread exists', () => {
    render(<ThreadView messages={[]} hasThread={false} />)
    expect(screen.getByText('No discussion yet. Start one.')).toBeTruthy()
  })

  test('renders sender and content', () => {
    render(<ThreadView messages={[msg(1, 'hello there')]} hasThread={true} />)
    expect(screen.getByText('Ada')).toBeTruthy()
    expect(screen.getByText('hello there')).toBeTruthy()
  })

  test('renders URLs in messages as safe links', () => {
    render(<ThreadView messages={[msg(1, 'see https://example.com/x')]} hasThread={true} />)
    const a = screen.getByRole('link') as HTMLAnchorElement
    expect(a.href).toBe('https://example.com/x')
    expect(a.rel).toContain('noopener')
    expect(a.target).toBe('_blank')
  })

  test('message content is rendered as text, not HTML', () => {
    const { container } = render(
      <ThreadView messages={[msg(1, '<img src=x onerror=alert(1)>')]} hasThread={true} />
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
  })
})

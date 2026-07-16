// @vitest-environment jsdom
import { render, screen } from '@testing-library/preact'
import { describe, expect, test, vi } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { ThreadView } from './ThreadView'

function msg(id: number, content: string): ZulipMessage {
  return {
    id,
    sender_full_name: 'Ada',
    sender_email: 'ada@x.com',
    content,
    timestamp: 1700000000,
    subject: 'T · k',
  }
}

const noop = () => {}
function renderThread(over: Partial<Parameters<typeof ThreadView>[0]> = {}) {
  return render(
    <ThreadView
      messages={[]}
      hasThread={false}
      noPage={false}
      threadKey={null}
      ownEmail="me@x.com"
      ownUserId={17}
      realmUrl="https://zulip.example.com"
      editState={null}
      busy={false}
      onStartEdit={noop}
      onCancelEdit={noop}
      onSaveEdit={noop}
      onDelete={noop}
      onToggleReaction={noop}
      onRendered={noop}
      {...over}
    />
  )
}

describe('ThreadView', () => {
  test('no-page and empty states', () => {
    renderThread({ noPage: true })
    expect(screen.getByText('Open a web page to see its discussion.')).toBeTruthy()
  })

  test('renders sanitized message content via MessageView', () => {
    const { container } = renderThread({
      messages: [msg(1, '<p>hi <em>there</em><script>x()</script></p>')],
      hasThread: true,
      threadKey: 'k1',
    })
    expect(container.querySelector('em')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
  })

  test('reports rendered message ids for read marking', () => {
    const onRendered = vi.fn()
    renderThread({ messages: [msg(1, '<p>a</p>'), msg(2, '<p>b</p>')], hasThread: true, threadKey: 'k1', onRendered })
    expect(onRendered).toHaveBeenCalledWith([1, 2])
  })

  test('own messages get actions, others do not', () => {
    const { container } = renderThread({
      messages: [msg(1, '<p>a</p>'), { ...msg(2, '<p>b</p>'), sender_email: 'me@x.com' }],
      hasThread: true,
      threadKey: 'k1',
    })
    expect(container.querySelectorAll('[title="Edit"]')).toHaveLength(1)
  })

  test('first message is not grouped; a same-sender follow-up within the window is', () => {
    const { container } = renderThread({
      messages: [msg(1, '<p>a</p>'), msg(2, '<p>b</p>')], // same sender + timestamp
      hasThread: true,
      threadKey: 'k1',
    })
    const rows = container.querySelectorAll('.message')
    expect(rows[0].classList.contains('grouped')).toBe(false)
    expect(rows[1].classList.contains('grouped')).toBe(true)
  })
})

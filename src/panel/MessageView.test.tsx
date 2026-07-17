// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, test, vi } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { MessageView } from './MessageView'

const REALM = 'https://zulip.example.com'

function msg(over: Partial<ZulipMessage> = {}): ZulipMessage {
  return {
    id: 1,
    sender_full_name: 'Ada',
    sender_email: 'ada@x.com',
    content: '<p>hello <strong>world</strong></p>',
    timestamp: 1700000000,
    subject: 'T · k',
    ...over,
  }
}

const noop = () => {}
function renderMsg(over: Partial<Parameters<typeof MessageView>[0]> = {}) {
  return render(
    <MessageView
      message={msg()}
      own={false}
      realmUrl={REALM}
      ownUserId={17}
      edit={null}
      busy={false}
      onStartEdit={noop}
      onCancelEdit={noop}
      onSaveEdit={noop}
      onDelete={noop}
      onToggleReaction={noop}
      {...over}
    />
  )
}

describe('MessageView', () => {
  test('renders sanitized Zulip HTML', () => {
    const { container } = renderMsg({ message: msg({ content: '<p>hi <strong>x</strong><script>bad()</script></p>' }) })
    expect(container.querySelector('strong')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
  })

  test('image placeholder swaps to img only on click', () => {
    const { container } = renderMsg({
      message: msg({ content: '<p><img src="https://cdn.x.com/a.png"></p>' }),
    })
    expect(container.querySelector('img')).toBeNull()
    const btn = container.querySelector('button.img-placeholder') as HTMLButtonElement
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.src).toBe('https://cdn.x.com/a.png')
  })

  test('edit/delete actions only on own messages', () => {
    const { container: other } = renderMsg({ own: false })
    expect(other.querySelector('[title="Edit"]')).toBeNull()
    expect(other.querySelector('[title="Delete"]')).toBeNull()
    const { container: mine } = renderMsg({ own: true })
    expect(mine.querySelector('[title="Edit"]')).toBeTruthy()
    expect(mine.querySelector('[title="Delete"]')).toBeTruthy()
  })

  test('delete requires a second confirming click', () => {
    const onDelete = vi.fn()
    renderMsg({ own: true, onDelete })
    fireEvent.click(screen.getByTitle('Delete'))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('Confirm delete'))
    expect(onDelete).toHaveBeenCalled()
  })

  test('reaction chips show counts, highlight own, and toggle', () => {
    const onToggleReaction = vi.fn()
    const reactions = [
      { emoji_name: '+1', emoji_code: '1f44d', reaction_type: 'unicode_emoji', user_id: 17 },
      { emoji_name: '+1', emoji_code: '1f44d', reaction_type: 'unicode_emoji', user_id: 8 },
    ]
    const { container } = renderMsg({ message: msg({ reactions }), onToggleReaction })
    const chip = container.querySelector('.reaction-chip') as HTMLButtonElement
    expect(chip.textContent).toContain('2')
    expect(chip.classList.contains('mine')).toBe(true)
    fireEvent.click(chip)
    expect(onToggleReaction).toHaveBeenCalledWith(
      expect.objectContaining({ emoji_code: '1f44d', reaction_type: 'unicode_emoji' })
    )
  })

  test('quick-reaction row opens from the + button', () => {
    const onToggleReaction = vi.fn()
    const { container } = renderMsg({ onToggleReaction })
    fireEvent.click(screen.getByTitle('Add reaction'))
    const first = container.querySelector('.quick-reactions button') as HTMLButtonElement
    fireEvent.click(first)
    expect(onToggleReaction).toHaveBeenCalled()
  })

  test('inline editor renders raw content, saves and cancels', () => {
    const onSaveEdit = vi.fn()
    const onCancelEdit = vi.fn()
    renderMsg({ own: true, edit: { raw: '**raw**' }, onSaveEdit, onCancelEdit })
    const box = screen.getByDisplayValue('**raw**') as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: 'changed' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onSaveEdit).toHaveBeenCalledWith('changed')
    fireEvent.click(screen.getByText('Cancel'))
    expect(onCancelEdit).toHaveBeenCalled()
  })

  test('shows an avatar with the sender initial when not grouped', () => {
    const { container } = renderMsg({ message: msg({ sender_full_name: 'Ada' }), grouped: false })
    const av = container.querySelector('.avatar') as HTMLElement
    expect(av).toBeTruthy()
    expect(av.textContent).toBe('A')
    expect(container.querySelector('.sender')?.textContent).toBe('Ada')
  })

  test('grouped message hides the avatar initial and the sender name', () => {
    const { container } = renderMsg({ message: msg({ sender_full_name: 'Ada' }), grouped: true })
    expect((container.querySelector('.avatar') as HTMLElement).textContent).toBe('')
    expect(container.querySelector('.sender')).toBeNull()
  })

  test('no reactions row is rendered when a message has no reactions', () => {
    const { container } = renderMsg({ message: msg({ reactions: [] }) })
    expect(container.querySelector('.reactions')).toBeNull()
  })

  test('the react (add-reaction) button is available on any message, not just own', () => {
    const { container } = renderMsg({ own: false })
    expect(container.querySelector('[title="Add reaction"]')).toBeTruthy()
  })
})

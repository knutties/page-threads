// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, test, vi } from 'vitest'
import { Composer } from './Composer'

describe('Composer', () => {
  test('sends trimmed text on submit and clears the box', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} disabled={false} />)
    const box = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: '  hello  ' } })
    fireEvent.submit(box.closest('form')!)
    expect(onSend).toHaveBeenCalledWith('hello')
    expect(box.value).toBe('')
  })

  test('does not send empty text', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} disabled={false} />)
    fireEvent.submit(screen.getByPlaceholderText('Write a message…').closest('form')!)
    expect(onSend).not.toHaveBeenCalled()
  })

  test('disabled state disables the controls', () => {
    render(<Composer onSend={() => {}} disabled={true} />)
    expect((screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement).disabled).toBe(true)
  })
})

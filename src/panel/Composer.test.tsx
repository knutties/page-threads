// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact'
import { useState } from 'preact/hooks'
import { describe, expect, test, vi } from 'vitest'
import { Composer } from './Composer'

/** Harness playing the App's role: owns the value, clears it on send. */
function Harness({ onSend }: { onSend: (t: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <Composer
      value={value}
      onInput={setValue}
      onSend={(t) => {
        onSend(t)
        setValue('')
      }}
      disabled={false}
    />
  )
}

describe('Composer', () => {
  test('sends trimmed text on submit; harness clears the box', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const box = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: '  hello  ' } })
    fireEvent.submit(box.closest('form')!)
    expect(onSend).toHaveBeenCalledWith('hello')
    expect(box.value).toBe('')
  })

  test('does not send empty text', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    fireEvent.submit(screen.getByPlaceholderText('Write a message…').closest('form')!)
    expect(onSend).not.toHaveBeenCalled()
  })

  test('Enter sends, Shift+Enter does not', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const box = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: 'hi' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hi')
  })

  test('Enter during IME composition does not send', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const box = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: 'こんにちは' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  test('disabled state disables the controls', () => {
    render(<Composer value="" onInput={() => {}} onSend={() => {}} disabled={true} />)
    expect((screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement).disabled).toBe(true)
  })
})

export function Composer({
  value,
  onInput,
  onSend,
  disabled,
  busy,
  offline = false,
}: {
  value: string
  onInput: (text: string) => void
  onSend: (text: string) => void
  disabled: boolean
  busy: boolean
  offline?: boolean
}) {
  function submit(e: Event) {
    e.preventDefault()
    if (busy || offline) return // a send is in flight, or we're offline
    const t = value.trim()
    if (!t) return
    onSend(t)
  }

  return (
    <form class="composer" onSubmit={submit}>
      <textarea
        value={value}
        onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          // isComposing guards IME input; keyCode 229 is the legacy signal some engines still use.
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) submit(e)
        }}
        placeholder={offline ? 'Offline — reconnect to send' : 'Write a message…'}
        disabled={disabled}
      />
      <button type="submit" disabled={disabled || busy || offline || !value.trim()}>
        Send
      </button>
    </form>
  )
}

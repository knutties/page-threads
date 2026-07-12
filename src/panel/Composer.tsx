export function Composer({
  value,
  onInput,
  onSend,
  disabled,
}: {
  value: string
  onInput: (text: string) => void
  onSend: (text: string) => void
  disabled: boolean
}) {
  function submit(e: Event) {
    e.preventDefault()
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
        placeholder="Write a message…"
        disabled={disabled}
      />
      <button type="submit" disabled={disabled || !value.trim()}>
        Send
      </button>
    </form>
  )
}

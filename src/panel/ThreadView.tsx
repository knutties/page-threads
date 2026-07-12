import { useEffect, useRef } from 'preact/hooks'
import type { ZulipMessage } from '../shared/zulipClient'
import { splitLinks } from './linkify'
import { shouldStickToBottom } from './scroll'

export function ThreadView({
  messages,
  hasThread,
  noPage,
}: {
  messages: ZulipMessage[]
  hasThread: boolean
  noPage: boolean
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const prevCount = useRef(0)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    // Thread switch (list replaced/shrunk) always jumps to bottom; live appends
    // only stick when the reader was already near the bottom.
    const replaced = prevCount.current === 0 || messages.length < prevCount.current
    if (replaced || shouldStickToBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) {
      el.scrollTop = el.scrollHeight
    }
    prevCount.current = messages.length
  }, [messages])

  if (noPage) return <div class="empty">Open a web page to see its discussion.</div>
  if (!hasThread && messages.length === 0) {
    return <div class="empty">No discussion yet. Start one.</div>
  }
  return (
    <ul class="messages" ref={listRef}>
      {messages.map((m) => (
        <li key={m.id}>
          <div class="meta">
            <span class="sender">{m.sender_full_name}</span>
            <span class="time">{new Date(m.timestamp * 1000).toLocaleString()}</span>
          </div>
          <div class="body">
            {m.content.split('\n').map((line, i) => (
              <p key={i}>
                {splitLinks(line).map((seg) =>
                  seg.kind === 'link' ? (
                    <a href={seg.value} target="_blank" rel="noopener noreferrer">
                      {seg.value}
                    </a>
                  ) : (
                    seg.value
                  )
                )}
              </p>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}

import type { ZulipMessage } from '../shared/zulipClient'
import { splitLinks } from './linkify'

export function ThreadView({ messages, hasThread }: { messages: ZulipMessage[]; hasThread: boolean }) {
  if (!hasThread && messages.length === 0) {
    return <div class="empty">No discussion yet. Start one.</div>
  }
  return (
    <ul class="messages">
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

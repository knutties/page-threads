import { useEffect, useRef } from 'preact/hooks'
import type { ZulipMessage } from '../shared/zulipClient'
import { MessageView, type ReactionInput } from './MessageView'
import { startsNewGroup } from './messageGroup'
import { shouldStickToBottom } from './scroll'

export function ThreadView({
  messages,
  hasThread,
  noPage,
  threadKey,
  ownEmail,
  ownUserId,
  realmUrl,
  editState,
  busy,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onToggleReaction,
  onRendered,
}: {
  messages: ZulipMessage[]
  hasThread: boolean
  noPage: boolean
  threadKey: string | null
  ownEmail: string
  ownUserId: number | null
  realmUrl: string
  editState: { id: number; raw: string } | null
  busy: boolean
  onStartEdit: (id: number) => void
  onCancelEdit: () => void
  onSaveEdit: (id: number, content: string) => void
  onDelete: (id: number) => void
  onToggleReaction: (id: number, r: ReactionInput) => void
  onRendered: (ids: number[], topicKey: string) => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const prevKey = useRef<string | null>(null)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    // Thread switch (key changed) always jumps to bottom (backlog #6); live
    // appends only stick when the reader was already near the bottom.
    const keyChanged = threadKey !== prevKey.current
    prevKey.current = threadKey
    if (keyChanged || shouldStickToBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) {
      el.scrollTop = el.scrollHeight
    }
    if (messages.length && threadKey) onRendered(messages.map((m) => m.id), threadKey)
  }, [messages, threadKey])

  if (noPage) return <div class="empty">Open a web page to see its discussion.</div>
  if (!hasThread && messages.length === 0) {
    return <div class="empty">No discussion yet. Start one.</div>
  }
  return (
    <ul class="messages" ref={listRef}>
      {messages.map((m, i) => (
        <MessageView
          key={m.id}
          message={m}
          grouped={!startsNewGroup(messages[i - 1] ?? null, m)}
          own={m.sender_email === ownEmail}
          realmUrl={realmUrl}
          ownUserId={ownUserId}
          edit={editState?.id === m.id ? { raw: editState.raw } : null}
          busy={busy}
          onStartEdit={() => onStartEdit(m.id)}
          onCancelEdit={onCancelEdit}
          onSaveEdit={(content) => onSaveEdit(m.id, content)}
          onDelete={() => onDelete(m.id)}
          onToggleReaction={(r) => onToggleReaction(m.id, r)}
        />
      ))}
    </ul>
  )
}

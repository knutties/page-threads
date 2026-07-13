import { useState } from 'preact/hooks'
import type { ZulipMessage, ZulipReaction } from '../shared/zulipClient'
import { sanitizeMessageHtml } from './renderMessage'

export interface ReactionInput {
  emoji_name: string
  emoji_code: string
  reaction_type: string
}

export const QUICK_REACTIONS: Array<{ emoji_name: string; emoji_code: string; rendered: string }> = [
  { emoji_name: '+1', emoji_code: '1f44d', rendered: '👍' },
  { emoji_name: 'heart', emoji_code: '2764', rendered: '❤️' },
  { emoji_name: 'smile', emoji_code: '1f604', rendered: '😄' },
  { emoji_name: 'tada', emoji_code: '1f389', rendered: '🎉' },
  { emoji_name: 'cry', emoji_code: '1f622', rendered: '😢' },
  { emoji_name: 'eyes', emoji_code: '1f440', rendered: '👀' },
]

function emojiFromCode(code: string): string {
  try {
    return String.fromCodePoint(...code.split('-').map((c) => parseInt(c, 16)))
  } catch {
    return '❓'
  }
}

function groupReactions(reactions: ZulipReaction[] | undefined, ownUserId: number | null) {
  const groups = new Map<string, { reaction: ZulipReaction; count: number; mine: boolean }>()
  for (const r of reactions ?? []) {
    const key = `${r.reaction_type}:${r.emoji_code}`
    const g = groups.get(key) ?? { reaction: r, count: 0, mine: false }
    g.count++
    if (ownUserId !== null && r.user_id === ownUserId) g.mine = true
    groups.set(key, g)
  }
  return [...groups.values()]
}

export function MessageView({
  message,
  own,
  realmUrl,
  ownUserId,
  edit,
  busy,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onToggleReaction,
}: {
  message: ZulipMessage
  own: boolean
  realmUrl: string
  ownUserId: number | null
  edit: { raw: string } | null
  busy: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: (content: string) => void
  onDelete: () => void
  onToggleReaction: (r: ReactionInput) => void
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [picking, setPicking] = useState(false)
  const [editText, setEditText] = useState(edit?.raw ?? '')
  const [editKey, setEditKey] = useState<string | null>(null)

  // Reset local editor text when a (new) edit session starts.
  const currentEditKey = edit ? `${message.id}:${edit.raw}` : null
  if (currentEditKey !== editKey) {
    setEditKey(currentEditKey)
    setEditText(edit?.raw ?? '')
  }

  function onBodyClick(e: Event) {
    const target = (e.target as HTMLElement).closest?.('button.img-placeholder') as HTMLButtonElement | null
    if (!target) return
    const src = target.getAttribute('data-src')
    if (!src) return
    const img = target.ownerDocument.createElement('img')
    img.src = src
    img.className = 'loaded-image'
    target.replaceWith(img)
  }

  const groups = groupReactions(message.reactions, ownUserId)

  return (
    <li class="message">
      <div class="meta">
        <span class="sender">{message.sender_full_name}</span>
        <span class="time">{new Date(message.timestamp * 1000).toLocaleString()}</span>
        {own && !edit && (
          <span class="msg-actions">
            <button title="Edit" disabled={busy} onClick={onStartEdit}>
              ✎
            </button>
            {confirmingDelete ? (
              <button title="Confirm delete" class="danger" disabled={busy} onClick={onDelete}>
                Delete?
              </button>
            ) : (
              <button title="Delete" disabled={busy} onClick={() => setConfirmingDelete(true)}>
                🗑
              </button>
            )}
          </span>
        )}
      </div>
      {edit ? (
        <div class="msg-editor">
          <textarea value={editText} onInput={(e) => setEditText((e.target as HTMLTextAreaElement).value)} />
          <div>
            <button disabled={busy || !editText.trim()} onClick={() => onSaveEdit(editText)}>
              Save
            </button>
            <button disabled={busy} onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div
          class="body zulip-rendered"
          onClick={onBodyClick}
          dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(message.content, realmUrl) }}
        />
      )}
      <div class="reactions">
        {groups.map((g) => (
          <button
            key={`${g.reaction.reaction_type}:${g.reaction.emoji_code}`}
            class={g.mine ? 'reaction-chip mine' : 'reaction-chip'}
            disabled={busy}
            onClick={() =>
              onToggleReaction({
                emoji_name: g.reaction.emoji_name,
                emoji_code: g.reaction.emoji_code,
                reaction_type: g.reaction.reaction_type,
              })
            }
          >
            {emojiFromCode(g.reaction.emoji_code)} {g.count}
          </button>
        ))}
        <button title="Add reaction" class="reaction-add" disabled={busy} onClick={() => setPicking(!picking)}>
          +
        </button>
        {picking && (
          <span class="quick-reactions">
            {QUICK_REACTIONS.map((q) => (
              <button
                key={q.emoji_code}
                disabled={busy}
                onClick={() => {
                  setPicking(false)
                  onToggleReaction({ emoji_name: q.emoji_name, emoji_code: q.emoji_code, reaction_type: 'unicode_emoji' })
                }}
              >
                {q.rendered}
              </button>
            ))}
          </span>
        )}
      </div>
    </li>
  )
}

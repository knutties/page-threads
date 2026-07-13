import type { ZulipMessage, ZulipReaction } from '../shared/zulipClient'

export type ThreadAction =
  | { type: 'history'; messages: ZulipMessage[] }
  | { type: 'append'; message: ZulipMessage }
  | { type: 'update'; id: number; content: string }
  | { type: 'remove'; id: number }
  | { type: 'reaction'; op: 'add' | 'remove'; id: number; reaction: ZulipReaction }

const sameReaction = (a: ZulipReaction, b: ZulipReaction) =>
  a.emoji_code === b.emoji_code && a.reaction_type === b.reaction_type && a.user_id === b.user_id

export function threadReducer(messages: ZulipMessage[], action: ThreadAction): ZulipMessage[] {
  switch (action.type) {
    case 'history':
      return [...action.messages].sort((a, b) => a.id - b.id)
    case 'append':
      if (messages.some((m) => m.id === action.message.id)) return messages
      return [...messages, action.message].sort((a, b) => a.id - b.id)
    case 'update':
      if (!messages.some((m) => m.id === action.id)) return messages
      return messages.map((m) => (m.id === action.id ? { ...m, content: action.content } : m))
    case 'remove':
      if (!messages.some((m) => m.id === action.id)) return messages
      return messages.filter((m) => m.id !== action.id)
    case 'reaction':
      return messages.map((m) => {
        if (m.id !== action.id) return m
        const current = m.reactions ?? []
        if (action.op === 'add') {
          if (current.some((r) => sameReaction(r, action.reaction))) return m
          return { ...m, reactions: [...current, action.reaction] }
        }
        return { ...m, reactions: current.filter((r) => !sameReaction(r, action.reaction)) }
      })
  }
}

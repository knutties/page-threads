import type { ZulipMessage } from '../shared/zulipClient'

export type ThreadAction =
  | { type: 'history'; messages: ZulipMessage[] }
  | { type: 'append'; message: ZulipMessage }

export function threadReducer(messages: ZulipMessage[], action: ThreadAction): ZulipMessage[] {
  switch (action.type) {
    case 'history':
      return [...action.messages].sort((a, b) => a.id - b.id)
    case 'append':
      if (messages.some((m) => m.id === action.message.id)) return messages
      return [...messages, action.message].sort((a, b) => a.id - b.id)
  }
}

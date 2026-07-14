/** Toolbar badge text for a tab's topic (spec §6.4). */
export function badgeText(unread: number, hasThread: boolean): string {
  if (!hasThread) return ''
  if (unread <= 0) return '•'
  return unread > 99 ? '99+' : String(unread)
}

/**
 * The topicKey is the trailing `· <16 base64url chars>` of a topic name
 * (spec §4.6). Extract it so unread counts can be keyed by topicKey.
 */
export function keyFromTopicName(name: string): string | null {
  const m = name.match(/· ([A-Za-z0-9_-]{16})$/)
  return m ? m[1] : null
}

import type { ZulipMessage } from '../shared/zulipClient'

export const GROUP_GAP_SECONDS = 300

/** True when `cur` should start a fresh avatar/name block rather than join `prev`'s. */
export function startsNewGroup(prev: ZulipMessage | null, cur: ZulipMessage): boolean {
  if (!prev) return true
  if (prev.sender_email !== cur.sender_email) return true
  return cur.timestamp - prev.timestamp > GROUP_GAP_SECONDS
}

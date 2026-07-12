/** True when the view is close enough to the bottom that new messages should keep it pinned there. */
export function shouldStickToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 100
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

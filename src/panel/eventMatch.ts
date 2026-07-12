/** Threads are identified by the `· <key>` suffix, never the title (spec §4.6). */
export function topicMatchesKey(topic: string, key: string): boolean {
  return topic.endsWith(`· ${key}`)
}

/** base64url(sha256(entityUri))[:16] — spec §4.6. Uses Web Crypto (panel/SW and Node 20+). */
export async function topicKey(entityUri: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entityUri))
  let bin = ''
  for (const byte of new Uint8Array(digest)) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16)
}

export function topicName(title: string, key: string): string {
  let t = title.trim().slice(0, 40)
  const last = t.charCodeAt(t.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1) // drop dangling high surrogate
  t = t.trim()
  return `${t || 'Untitled'} · ${key}`
}

export function matchTopicByKey(topics: string[], key: string): string | null {
  const suffix = `· ${key}`
  return topics.find((t) => t.endsWith(suffix)) ?? null
}

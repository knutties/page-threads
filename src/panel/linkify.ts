export type Segment = { kind: 'text'; value: string } | { kind: 'link'; value: string }

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

/** Split plain text into text/link segments for safe rendering (no innerHTML). */
export function splitLinks(text: string): Segment[] {
  const segments: Segment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    if (start > last) segments.push({ kind: 'text', value: text.slice(last, start) })
    segments.push({ kind: 'link', value: m[0] })
    last = start + m[0].length
  }
  if (last < text.length) segments.push({ kind: 'text', value: text.slice(last) })
  return segments
}

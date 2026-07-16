/** "host · N messages" for the panel header; drops the host if the URI won't parse. */
export function headerSubtitle(entityUri: string, count: number): string {
  let host = ''
  try {
    host = new URL(entityUri.replace(/^web:/, '')).host
  } catch {
    host = ''
  }
  const msgs = `${count} message${count === 1 ? '' : 's'}`
  return host ? `${host} · ${msgs}` : msgs
}

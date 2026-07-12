/** In-memory per-thread composer drafts, keyed by entityUri. Panel-lifetime only. */
export class Drafts {
  private map = new Map<string, string>()

  get(uri: string): string {
    return this.map.get(uri) ?? ''
  }

  set(uri: string, text: string): void {
    if (text) this.map.set(uri, text)
    else this.map.delete(uri)
  }

  clear(uri: string): void {
    this.map.delete(uri)
  }
}

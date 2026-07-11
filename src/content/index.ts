import { canonicalize } from '../shared/canonicalize'
import type { ContentToSw } from '../shared/messages'

const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
const entityUri = 'web:' + canonicalize(location.href, link?.getAttribute('href') ?? null)

const msg: ContentToSw = { type: 'pageEntity', entityUri, title: document.title }
void chrome.runtime.sendMessage(msg).catch(() => {
  // Service worker may not be listening yet (e.g. right after install); harmless.
})

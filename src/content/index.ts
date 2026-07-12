import { canonicalize } from '../shared/canonicalize'
import type { ContentToSw } from '../shared/messages'
import { createNavWatcher } from './navWatcher'

function resolveUri(): string {
  const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  return 'web:' + canonicalize(location.href, link?.getAttribute('href') ?? null)
}

function report(entityUri: string): void {
  const msg: ContentToSw = { type: 'pageEntity', entityUri, title: document.title }
  void chrome.runtime.sendMessage(msg).catch(() => {
    // Service worker may not be listening yet (e.g. right after install); harmless.
  })
}

const initialUri = resolveUri()
report(initialUri)

const watcher = createNavWatcher({ resolve: resolveUri, onChange: report })
watcher.seed(initialUri)

window.addEventListener('popstate', () => watcher.trigger())

// SPA detection (spec §Content script): Navigation API where available,
// else title MutationObserver + 500ms location.href poll.
const navigation = (window as { navigation?: EventTarget }).navigation
if (navigation) {
  navigation.addEventListener('navigate', () => watcher.trigger())
} else {
  const title = document.querySelector('title')
  if (title) {
    new MutationObserver(() => watcher.trigger()).observe(title, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  }
  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      watcher.trigger()
    }
  }, 500)
}

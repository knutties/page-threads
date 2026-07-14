import { canonicalize } from '../shared/canonicalize'
import type { ContentToSw, SwToContent } from '../shared/messages'
import { createRulesetStore, isBlocked, type Ruleset } from '../shared/ruleset'
import { createNavWatcher } from './navWatcher'

const rulesetStore = createRulesetStore()
let ruleset: Ruleset = { canonical: {}, blocked: [] }

function pageDomain(): string {
  return location.hostname
}

function resolveUri(): string {
  const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  return 'web:' + canonicalize(location.href, link?.getAttribute('href') ?? null, ruleset.canonical)
}

function report(entityUri: string): void {
  const msg: ContentToSw = { type: 'pageEntity', entityUri, title: document.title }
  void chrome.runtime.sendMessage(msg).catch(() => {
    // Service worker may not be listening yet (e.g. right after install); harmless.
  })
}

function resolveAndReport(): void {
  // Blocked domains: send nothing, so the SW never learns the page (spec §7).
  if (isBlocked(pageDomain(), ruleset.blocked)) return
  report(resolveUri())
}

const watcher = createNavWatcher({
  resolve: () => (isBlocked(pageDomain(), ruleset.blocked) ? 'blocked:' + pageDomain() : resolveUri()),
  onChange: (uri) => {
    if (!uri.startsWith('blocked:')) report(uri)
  },
})

// Ruleset governs canonicalization AND blocking; load it before the first report.
void rulesetStore.load().then((rs) => {
  ruleset = rs
  watcher.seed(isBlocked(pageDomain(), rs.blocked) ? 'blocked:' + pageDomain() : resolveUri())
  resolveAndReport()
})

// A change to rules or the block-list re-resolves on the next navigation; also
// re-evaluate the current page once so a freshly-blocked domain stops reporting.
rulesetStore.watch((rs) => {
  ruleset = rs
  resolveAndReport()
})

window.addEventListener('popstate', () => watcher.trigger())

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

// The SW's tab-entity map dies with every MV3 service-worker restart; let it
// re-query this tab. A blocked domain returns nothing usable.
chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
  if (msg.type === 'queryEntity') {
    if (isBlocked(pageDomain(), ruleset.blocked)) {
      sendResponse(null)
    } else {
      sendResponse({ entityUri: resolveUri(), title: document.title })
    }
  }
})

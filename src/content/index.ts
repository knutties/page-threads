import { browser } from '../shared/browser'
import type { ContentToSw, SwToContent } from '../shared/messages'
import { RESOLVER_ID, RESOLVER_VERSION, resolveWebEntity } from '../shared/resolver'
import { createRulesetStore, isBlocked, type Ruleset } from '../shared/ruleset'
import { createNavWatcher } from './navWatcher'

const rulesetStore = createRulesetStore()
let ruleset: Ruleset = { canonical: {}, blocked: [] }
let loaded = false

function pageDomain(): string {
  return location.hostname
}

function resolveUri(): string {
  const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  return resolveWebEntity(location.href, link?.getAttribute('href') ?? null, ruleset.canonical).entityUri
}

function report(entityUri: string): void {
  const msg: ContentToSw = {
    type: 'pageEntity',
    entityUri,
    title: document.title,
    resolverId: RESOLVER_ID,
    resolverVersion: RESOLVER_VERSION,
  }
  void browser.runtime.sendMessage(msg).catch(() => {
    // Service worker may not be listening yet (e.g. right after install); harmless.
  })
}

function resolveAndReport(): void {
  if (!loaded) return // fail closed: don't report until the blocklist is known
  if (isBlocked(pageDomain(), ruleset.blocked)) {
    // Retract any entity the SW cached for this tab before the block took effect,
    // so a later tab re-activation can't resolve the now-blocked page.
    const msg: ContentToSw = { type: 'pageBlocked' }
    void browser.runtime.sendMessage(msg).catch(() => {})
    return
  }
  report(resolveUri())
}

const watcher = createNavWatcher({
  resolve: () => (isBlocked(pageDomain(), ruleset.blocked) ? 'blocked:' + pageDomain() : resolveUri()),
  onChange: (uri) => {
    if (loaded && !uri.startsWith('blocked:')) report(uri)
  },
})

// Ruleset governs canonicalization AND blocking; load it before the first report.
void rulesetStore.load().then((rs) => {
  ruleset = rs
  loaded = true
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
browser.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
  if (msg.type === 'queryEntity') {
    if (!loaded || isBlocked(pageDomain(), ruleset.blocked)) {
      sendResponse(null)
    } else {
      sendResponse({
        entityUri: resolveUri(),
        title: document.title,
        resolverId: RESOLVER_ID,
        resolverVersion: RESOLVER_VERSION,
      })
    }
  }
})

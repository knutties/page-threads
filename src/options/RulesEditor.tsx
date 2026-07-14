import { useEffect, useState } from 'preact/hooks'
import { createRulesetStore, type Ruleset } from '../shared/ruleset'
import type { Store } from '../shared/storage'
import { parseKeepParams, rulesReducer, validateRuleset, type RulesAction } from './rulesReducer'

export function RulesEditor({ store = createRulesetStore() }: { store?: Store<Ruleset> }) {
  const [ruleset, setRuleset] = useState<Ruleset>({ canonical: {}, blocked: [] })
  const [loaded, setLoaded] = useState(false)
  const [newDomain, setNewDomain] = useState('')
  const [newBlocked, setNewBlocked] = useState('')
  const [importText, setImportText] = useState('')
  const [exported, setExported] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void store.load().then((r) => {
      setRuleset(r)
      setLoaded(true)
    })
    return store.watch(setRuleset)
  }, [])

  async function apply(action: RulesAction) {
    const prev = ruleset
    const next = rulesReducer(prev, action)
    setRuleset(next)
    try {
      await store.save(next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch {
      setRuleset(prev)
      setError('Could not save — try again.')
    }
  }

  async function replaceAll(next: Ruleset) {
    const prev = ruleset
    setRuleset(next)
    try {
      await store.save(next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch {
      setRuleset(prev)
      setError('Could not save — try again.')
    }
  }

  function doImport() {
    let parsed: unknown
    try {
      parsed = JSON.parse(importText)
    } catch {
      setError('Invalid JSON: could not parse.')
      return
    }
    const result = validateRuleset(parsed)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    void replaceAll(result.value)
  }

  if (!loaded) return <div class="loading">Loading rules…</div>
  const domains = Object.keys(ruleset.canonical)

  return (
    <div class="rules-editor">
      {error && <div class="error" role="alert" onClick={() => setError(null)}>{error}</div>}
      {saved && <div class="saved" role="status">Saved ✓</div>}

      <section>
        <h2>Canonicalization rules</h2>
        <p class="hint">Per-domain overrides applied when a page has no accepted canonical link.</p>
        {domains.map((domain) => {
          const rule = ruleset.canonical[domain]
          return (
            <div class="rule-row" key={domain}>
              <input readOnly value={domain} />
              <input
                placeholder="keepParams (comma-separated)"
                value={(rule.keepParams ?? []).join(', ')}
                onBlur={(e) =>
                  void apply({
                    type: 'setKeepParams',
                    domain,
                    keepParams: parseKeepParams((e.target as HTMLInputElement).value),
                  })
                }
              />
              <input
                placeholder="pathRewrite (e.g. /watch)"
                value={rule.pathRewrite ?? ''}
                onBlur={(e) =>
                  void apply({ type: 'setPathRewrite', domain, pathRewrite: (e.target as HTMLInputElement).value })
                }
              />
              <button onClick={() => void apply({ type: 'removeDomain', domain })}>Remove</button>
            </div>
          )
        })}
        <div class="rule-add">
          <input
            placeholder="add domain, e.g. news.ycombinator.com"
            value={newDomain}
            onInput={(e) => setNewDomain((e.target as HTMLInputElement).value)}
          />
          <button
            onClick={() => {
              const d = newDomain.trim()
              if (d) void apply({ type: 'addDomain', domain: d })
              setNewDomain('')
            }}
          >
            Add domain
          </button>
        </div>
      </section>

      <section>
        <h2>Blocked domains</h2>
        <p class="hint">The extension stops reporting these domains — no new page reaches your realm. A discussion already open when you block a domain stays until you switch away.</p>
        {ruleset.blocked.map((domain) => (
          <div class="blocked-row" key={domain}>
            <span>{domain}</span>
            <button onClick={() => void apply({ type: 'removeBlocked', domain })}>Unblock</button>
          </div>
        ))}
        <div class="rule-add">
          <input
            placeholder="add blocked domain"
            value={newBlocked}
            onInput={(e) => setNewBlocked((e.target as HTMLInputElement).value)}
          />
          <button
            onClick={() => {
              const d = newBlocked.trim()
              if (d) void apply({ type: 'addBlocked', domain: d })
              setNewBlocked('')
            }}
          >
            Block
          </button>
        </div>
      </section>

      <section>
        <h2>Import / export</h2>
        <div class="io">
          <button onClick={() => setExported(JSON.stringify(ruleset, null, 2))}>Export</button>
          {exported !== null && (
            <textarea aria-label="exported ruleset" readOnly value={exported} rows={6} />
          )}
        </div>
        <div class="io">
          <textarea
            placeholder="paste ruleset JSON to import"
            value={importText}
            onInput={(e) => setImportText((e.target as HTMLTextAreaElement).value)}
            rows={6}
          />
          <button onClick={doImport}>Import</button>
        </div>
      </section>
    </div>
  )
}

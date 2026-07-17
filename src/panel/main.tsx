import { render } from 'preact'
import '../shared/theme.css'
import './style.css'
import { createSettingsStore } from '../shared/settings'
import { startThemeSync } from '../shared/theme'
import { App } from './App'

startThemeSync({
  store: createSettingsStore(),
  root: document.documentElement,
  mql: window.matchMedia('(prefers-color-scheme: dark)'),
})

render(<App />, document.getElementById('root')!)

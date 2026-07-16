import { render } from 'preact'
import '../shared/theme.css'
import './options.css'
import { createSettingsStore } from '../shared/settings'
import { startThemeSync } from '../shared/theme'
import { OptionsView } from './OptionsView'

startThemeSync({
  store: createSettingsStore(),
  root: document.documentElement,
  mql: window.matchMedia('(prefers-color-scheme: dark)'),
})

render(<OptionsView />, document.getElementById('root')!)

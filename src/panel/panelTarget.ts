import type { PageEntity } from '../shared/messages'

export interface PanelTargetState {
  pinned: boolean
  currentUri: string | null
}

export type PanelTargetEvent =
  | { type: 'push'; entity: PageEntity | null }
  | { type: 'pin' }
  | { type: 'unpin' }

export type PanelTargetAction = 'ignore' | 'switch' | 'clear' | 'refresh'

export interface PanelTargetResult {
  state: PanelTargetState
  action: PanelTargetAction
}

/** Pure decision core for follow-active-tab / pin semantics (spec §Panel). */
export function panelTarget(
  state: PanelTargetState,
  event: PanelTargetEvent,
  onNonWebPage: 'hold' | 'clear'
): PanelTargetResult {
  switch (event.type) {
    case 'pin':
      return { state: { ...state, pinned: true }, action: 'ignore' }
    case 'unpin':
      return { state: { ...state, pinned: false }, action: 'refresh' }
    case 'push': {
      if (state.pinned) return { state, action: 'ignore' }
      const uri = event.entity?.entityUri ?? null
      if (uri === null) {
        if (state.currentUri === null || onNonWebPage === 'hold') return { state, action: 'ignore' }
        return { state: { ...state, currentUri: null }, action: 'clear' }
      }
      if (uri === state.currentUri) return { state, action: 'ignore' }
      return { state: { ...state, currentUri: uri }, action: 'switch' }
    }
  }
}

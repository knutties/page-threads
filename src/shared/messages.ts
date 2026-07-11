import type { ZulipMessage } from './zulipClient'

export interface PageEntity {
  entityUri: string
  title: string
}

/** Content script → service worker, via chrome.runtime.sendMessage. */
export type ContentToSw = { type: 'pageEntity' } & PageEntity

/** Panel → service worker, via the 'panel' Port. */
export type PanelToSw = { type: 'getActiveEntity' }

/** Service worker → panel, via the 'panel' Port. */
export type SwToPanel =
  | { type: 'activeEntity'; entity: PageEntity | null }
  | { type: 'newMessage'; topic: string; message: ZulipMessage }
  | { type: 'reconnected' }

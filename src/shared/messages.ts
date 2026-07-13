import type { ZulipMessage, ZulipReaction } from './zulipClient'

export interface PageEntity {
  entityUri: string
  title: string
}

/** Content script → service worker, via chrome.runtime.sendMessage. */
export type ContentToSw = { type: 'pageEntity' } & PageEntity

/** Anything arriving at the service worker via chrome.runtime.sendMessage. */
export type RuntimeToSw = ContentToSw | { type: 'credentialsChanged' }

/** Service worker → content script, via chrome.tabs.sendMessage. */
export type SwToContent = { type: 'queryEntity' }

/** Panel → service worker, via the 'panel' Port. 'ping' exists solely to reset the MV3 service-worker idle timer. */
export type PanelToSw = { type: 'getActiveEntity' } | { type: 'ping' }

/** Service worker → panel, via the 'panel' Port. */
export type SwToPanel =
  | { type: 'activeEntity'; entity: PageEntity | null }
  | { type: 'newMessage'; topic: string; message: ZulipMessage }
  | { type: 'reconnected' }
  | { type: 'messageUpdated'; messageId: number; renderedContent: string }
  | { type: 'messageDeleted'; messageId: number }
  | { type: 'reactionChanged'; op: 'add' | 'remove'; messageId: number; reaction: ZulipReaction }

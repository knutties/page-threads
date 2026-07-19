import type { PageEntity } from '../shared/messages'
import { RESOLVER_ID, RESOLVER_VERSION } from '../shared/resolver'

/** The first message posted to a new topic — the §4.6 header. Records the resolver
 *  identity that produced the entity, so a future version bump is self-describing. */
export function headerMessage(entity: PageEntity, email: string): string {
  const representativeUrl = entity.entityUri.replace(/^web:/, '')
  // Defensive fallback: an entity from a version-skewed content script (e.g. an old
  // script still injected in an open tab during an extension update) can lack the
  // descriptor. Never bake `undefined@undefined` into the permanent header — fall
  // back to the current resolver identity.
  const resolverId = entity.resolverId ?? RESOLVER_ID
  const resolverVersion = entity.resolverVersion ?? RESOLVER_VERSION
  return [
    `🔗 Discussion for: ${entity.title}`,
    `Entity: \`${entity.entityUri}\` (resolver ${resolverId}@${resolverVersion})`,
    `Link: ${representativeUrl}`,
    `Started by ${email}`,
  ].join('\n')
}

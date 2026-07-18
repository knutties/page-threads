import type { PageEntity } from '../shared/messages'

/** The first message posted to a new topic — the §4.6 header. Records the resolver
 *  identity that produced the entity, so a future version bump is self-describing. */
export function headerMessage(entity: PageEntity, email: string): string {
  const representativeUrl = entity.entityUri.replace(/^web:/, '')
  return [
    `🔗 Discussion for: ${entity.title}`,
    `Entity: \`${entity.entityUri}\` (resolver ${entity.resolverId}@${entity.resolverVersion})`,
    `Link: ${representativeUrl}`,
    `Started by ${email}`,
  ].join('\n')
}

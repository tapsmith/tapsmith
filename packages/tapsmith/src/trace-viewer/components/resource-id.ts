import type { HierarchyNode } from './hierarchy-utils.js';
import { escapeJsString } from '../../js-string-escape.js';

/**
 * How `locator({ id })` reads an Android resource name, as the Android agent
 * matches it: a package-qualified id (`com.app:id/submit`) matches that
 * whole name, and an id with no package (no `:`) matches a name equal to it
 * (a React Native testID) or that entry under any package (`submit`).
 */

/** The entry name of a package-qualified id (`com.app:id/submit` → `submit`), or null. */
export function resourceIdEntryName(resourceId: string): string | null {
  const m = /^[^:/]+:id\/(.+)$/.exec(resourceId);
  return m ? m[1] : null;
}

/**
 * The `locator({ id })` code naming an Android node by its full resource id,
 * when a candidate named it by the bare entry `id` (null otherwise): what
 * pins it when another package shares the entry name.
 */
export function fullResourceIdUpgrade(id: string, node: HierarchyNode): string | null {
  const resourceId = node.attributes.get('resource-id');
  if (!resourceId || resourceId === id || resourceIdEntryName(resourceId) !== id) return null;
  return `device.locator({ id: "${escapeJsString(resourceId)}" })`;
}

/** Whether `locator({ id })` finds an Android element whose resource name is `resourceId`. */
export function androidResourceIdMatches(resourceId: string, id: string): boolean {
  return resourceId === id || (!id.includes(':') && resourceIdEntryName(resourceId) === id);
}

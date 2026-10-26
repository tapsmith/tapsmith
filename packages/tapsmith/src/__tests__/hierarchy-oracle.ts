import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseBounds } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import type { ElementInfo } from '../grpc-client.js';
import { formatHierarchy, semanticNodes } from '../mcp/hierarchy-formatter.js';
import { suggestionsFromMatches } from '../mcp/agent-suggestions.js';

/**
 * A stand-in for the device agent in tests of candidate GENERATION (escaping,
 * glyph handling, ranking): it answers "what does this locator match?" from
 * a fixture hierarchy, so a test can show what the snapshot would offer for
 * that screen. Production asks the agent itself (PILOT-848).
 *
 * Fixture nodes without bounds get distinct ones, as every node of a real
 * dump has them and suggestions are tied to their node by bounds.
 */
export function formatWithFixtureMatches(roots: HierarchyNode[]): ReturnType<typeof formatHierarchy> {
  let next = 0;
  const visit = (node: HierarchyNode) => {
    if (!node.attributes.has('bounds')) {
      const top = 10_000 + next++ * 10;
      node.attributes.set('bounds', `[0,${top}][10,${top + 10}]`);
    }
    node.children.forEach(visit);
  };
  roots.forEach(visit);

  const asElement = (node: HierarchyNode): ElementInfo => ({
    elementId: '',
    className: node.attributes.get('class') ?? node.attributes.get('type') ?? '',
    text: node.attributes.get('text') ?? node.attributes.get('label') ?? '',
    bounds: parseBounds(node.attributes.get('bounds') ?? '') ?? undefined,
  }) as ElementInfo;

  const matchesOf = (code: string) => {
    const parsed = parseSelectorString(code);
    return parsed ? findMatchingNodes(roots, parsed).map(asElement) : null;
  };
  return formatHierarchy(roots, suggestionsFromMatches(semanticNodes(roots), matchesOf));
}

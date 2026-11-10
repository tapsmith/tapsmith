/**
 * The `tapsmith://api-reference` MCP resource: docs/api-reference.md, served
 * to agents so they read the API rather than guess it (docs/agents.md).
 *
 * The build bundles every docs page into the package's docs/ directory
 * (scripts/docs-bundle.mjs), which the npm package ships beside dist/. The
 * bundled copy is looked for first, then the repo's docs/ for a checkout
 * running from src/ under tsx.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const URI = 'tapsmith://api-reference';
const MIME_TYPE = 'text/markdown';

/** Where the doc may be, relative to this module's directory (dist/mcp or src/mcp). */
function candidatePaths(fromDir: string): string[] {
  const candidates: string[] = [];
  // dist/mcp -> <package>/docs: the copy `npm run build` bundles, and the only
  // one an installed package has. From src/mcp the same directory is a build's
  // leftover, so a checkout under tsx reads the repo's own page below instead.
  if (path.basename(path.resolve(fromDir, '..')) === 'dist') {
    candidates.push(path.resolve(fromDir, '../../docs/api-reference.md'));
  }
  // src/mcp or dist/mcp -> the repo root's docs/, but only inside the repo's
  // packages/tapsmith. From node_modules/tapsmith the same four levels up is
  // the user's project, whose docs/api-reference.md is not Tapsmith's.
  if (path.basename(path.resolve(fromDir, '../../..')) === 'packages') {
    candidates.push(path.resolve(fromDir, '../../../../docs/api-reference.md'));
  }
  return candidates;
}

/** The first existing copy of docs/api-reference.md, or undefined if there is none. */
export function resolveApiReferencePath(fromDir: string = import.meta.dirname): string | undefined {
  return candidatePaths(fromDir).find((p) => fs.existsSync(p));
}

let warnedMissing = false;

/**
 * Register the resource on `server`. A missing doc means the package was built
 * or published without it: say so once per process (UI mode builds a server
 * per HTTP session), on stderr because stdout carries the stdio protocol, and
 * start without the resource rather than refuse to start.
 */
export function registerApiReferenceResource(server: McpServer, fromDir: string = import.meta.dirname): void {
  const docPath = resolveApiReferencePath(fromDir);
  if (!docPath) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.error(
        `tapsmith mcp-server: the ${URI} resource is not available: docs/api-reference.md was not found at ` +
          `${candidatePaths(fromDir).join(' or ')}. This Tapsmith package was built without it; please report it.`,
      );
    }
    return;
  }

  server.resource(
    'Tapsmith API Reference',
    URI,
    {
      description:
        'Complete API reference for the Tapsmith mobile testing framework. Read this to understand available methods when writing tests.',
      mimeType: MIME_TYPE,
    },
    () => ({
      // Read on request, so a doc edited in a checkout is served as it is now.
      contents: [{ uri: URI, text: fs.readFileSync(docPath, 'utf-8'), mimeType: MIME_TYPE }],
    }),
  );
}

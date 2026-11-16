import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../mcp/index.js';

// docs/agents.md and docs/mcp-server.md both tell agents to read the
// `tapsmith://api-reference` resource. It never registered (PILOT-359): the
// path was one directory short, the npm package ships only dist/, and an
// existsSync guard skipped the registration without a word. These pin the two
// layouts it must be found in, and that a missing file is said out loud.

const REPO_DOC = path.resolve(fileURLToPath(import.meta.url), '../../../../../docs/api-reference.md');
const URI = 'tapsmith://api-reference';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-api-ref-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function connect(server: McpServer): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'api-ref-probe', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Write `<root>/<rel>` with `text`, creating its directories. */
function write(root: string, rel: string, text: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

describe('tapsmith://api-reference', () => {
  it('is listed and serves docs/api-reference.md when run from the repo', async () => {
    const client = await connect(createMcpServer());
    try {
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toContain(URI);
      expect(resources.find((r) => r.uri === URI)?.mimeType).toBe('text/markdown');

      const { contents } = await client.readResource({ uri: URI });
      expect(contents).toHaveLength(1);
      expect(contents[0]).toMatchObject({ uri: URI, mimeType: 'text/markdown' });
      expect((contents[0] as { text: string }).text).toBe(fs.readFileSync(REPO_DOC, 'utf-8'));
    } finally {
      await client.close();
    }
  });
});

describe('resolveApiReferencePath', () => {
  it('finds the copy the build bundles into the package docs/, the only one an installed package has', async () => {
    const { resolveApiReferencePath } = await import('../mcp/api-reference.js');
    // node_modules/tapsmith/dist/mcp, with no repo around it.
    const pkg = path.join(tmpDir, 'node_modules', 'tapsmith');
    const bundled = write(pkg, 'docs/api-reference.md', '# bundled');
    expect(resolveApiReferencePath(path.join(pkg, 'dist', 'mcp'))).toBe(bundled);
  });

  it('falls back to the repo copy from src/mcp, where nothing is bundled', async () => {
    const { resolveApiReferencePath } = await import('../mcp/api-reference.js');
    const repoDoc = write(tmpDir, 'docs/api-reference.md', '# repo');
    expect(resolveApiReferencePath(path.join(tmpDir, 'packages', 'tapsmith', 'src', 'mcp'))).toBe(repoDoc);
  });

  it('prefers the bundled copy when a built dist/ sits inside the repo', async () => {
    const { resolveApiReferencePath } = await import('../mcp/api-reference.js');
    write(tmpDir, 'docs/api-reference.md', '# repo');
    const bundled = write(tmpDir, 'packages/tapsmith/docs/api-reference.md', '# bundled');
    expect(resolveApiReferencePath(path.join(tmpDir, 'packages', 'tapsmith', 'dist', 'mcp'))).toBe(bundled);
  });

  it('reads the repo copy from src/mcp even when a build left a bundled copy beside src/', async () => {
    const { resolveApiReferencePath } = await import('../mcp/api-reference.js');
    const repoDoc = write(tmpDir, 'docs/api-reference.md', '# repo');
    write(tmpDir, 'packages/tapsmith/docs/api-reference.md', '# a build leftover');
    expect(resolveApiReferencePath(path.join(tmpDir, 'packages', 'tapsmith', 'src', 'mcp'))).toBe(repoDoc);
  });

  it("never serves the user's own docs/api-reference.md from an installed package", async () => {
    const { resolveApiReferencePath } = await import('../mcp/api-reference.js');
    // Four levels up from node_modules/tapsmith/dist/mcp is the user's
    // project, not the Tapsmith repo: its docs/ are not Tapsmith's.
    write(tmpDir, 'docs/api-reference.md', '# the user project\'s own API docs');
    expect(resolveApiReferencePath(path.join(tmpDir, 'node_modules', 'tapsmith', 'dist', 'mcp'))).toBeUndefined();
  });

  it('returns undefined when neither copy exists', async () => {
    const { resolveApiReferencePath } = await import('../mcp/api-reference.js');
    expect(resolveApiReferencePath(path.join(tmpDir, 'packages', 'tapsmith', 'dist', 'mcp'))).toBeUndefined();
  });
});

describe('registerApiReferenceResource', () => {
  it('serves the file it resolved, read when asked for', async () => {
    const { registerApiReferenceResource } = await import('../mcp/api-reference.js');
    const pkg = path.join(tmpDir, 'node_modules', 'tapsmith');
    const bundled = write(pkg, 'docs/api-reference.md', '# first');
    const server = new McpServer({ name: 't', version: '0' });
    registerApiReferenceResource(server, path.join(pkg, 'dist', 'mcp'));
    const client = await connect(server);
    try {
      fs.writeFileSync(bundled, '# second');
      const { contents } = await client.readResource({ uri: URI });
      expect((contents[0] as { text: string }).text).toBe('# second');
    } finally {
      await client.close();
    }
  });

  it('warns once on stderr, naming where it looked, when the file is missing', async () => {
    // A fresh module, so the once-per-process flag starts unset.
    vi.resetModules();
    const { registerApiReferenceResource } = await import('../mcp/api-reference.js');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdoutLog = vi.spyOn(console, 'log');
    const stdoutWrite = vi.spyOn(process.stdout, 'write');
    const fromDir = path.join(tmpDir, 'packages', 'tapsmith', 'dist', 'mcp');

    // UI mode builds one server per HTTP session: two sessions, one warning.
    for (let i = 0; i < 2; i++) {
      const server = new McpServer({ name: 't', version: '0' });
      registerApiReferenceResource(server, fromDir);
      const client = await connect(server);
      try {
        // Nothing registered: the server does not advertise resources at all.
        expect(client.getServerCapabilities()?.resources).toBeUndefined();
      } finally {
        await client.close();
      }
    }

    expect(stderr).toHaveBeenCalledTimes(1);
    const message = String(stderr.mock.calls[0][0]);
    expect(message).toContain(URI);
    expect(message).toContain(path.join(tmpDir, 'packages', 'tapsmith', 'docs', 'api-reference.md'));
    expect(message).toContain(path.join(tmpDir, 'docs', 'api-reference.md'));
    // stdout carries the stdio protocol; a warning there would corrupt it.
    expect(stdoutLog).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isYarnPnp, projectUsesYarnPnp, yarnPnpRefusal } from '../yarn-pnp.js';

// Yarn's `.pnp.cjs` runtime sets `process.versions.pnp` (to "3" on Yarn 2-4)
// in every process it is loaded into, which is how `yarn tapsmith …` runs.
const PNP_VERSIONS = { node: '24.0.0', pnp: '3' };
const PLAIN_VERSIONS = { node: '24.0.0' };

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-pnp-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const PNP = () => ({ versions: PNP_VERSIONS, cwd: dir });
const PLAIN = () => ({ versions: PLAIN_VERSIONS, cwd: dir });

describe('yarnPnpRefusal()', () => {
  it('refuses the commands that run tests under Plug\'n\'Play, naming the linker fix', () => {
    for (const command of ['test', 'verify', 'mcp-server']) {
      const refusal = yarnPnpRefusal(command, PNP());
      expect(refusal, command).toBeDefined();
      expect(refusal!.code).toBe('YARN_PNP_UNSUPPORTED');
      expect(refusal!.message).toContain("Plug'n'Play");
      expect(refusal!.fix).toContain('nodeLinker: node-modules');
      expect(refusal!.fix).toContain('.yarnrc.yml');
      expect(refusal!.fix).toContain('yarn install');
    }
  });

  it('lets every other command run: none of them starts tsx, and the daemon and agent packages are unplugged', () => {
    for (const command of ['doctor', 'init', 'list-devices', 'show-trace', 'show-report', 'telemetry', 'create-avd']) {
      expect(yarnPnpRefusal(command, PNP()), command).toBeUndefined();
    }
  });

  it('refuses nothing outside Plug\'n\'Play', () => {
    for (const command of ['test', 'verify', 'mcp-server']) {
      expect(yarnPnpRefusal(command, PLAIN()), command).toBeUndefined();
    }
  });
});

// `npx tapsmith …` in a Plug'n'Play project runs a downloaded copy under plain
// Node: no `process.versions.pnp`, and the project's own tapsmith is in a zip.
describe('isYarnPnp() without the PnP runtime', () => {
  function writeProject(root: string): string {
    fs.writeFileSync(path.join(root, 'package.json'), '{ "devDependencies": { "tapsmith": "^0.6.0" } }\n');
    fs.writeFileSync(path.join(root, '.pnp.cjs'), '// pnp\n');
    const sub = path.join(root, 'apps', 'mobile');
    fs.mkdirSync(sub, { recursive: true });
    return sub;
  }

  it("is true in (or below) a project with .pnp.cjs that can't resolve tapsmith from node_modules", () => {
    const sub = writeProject(dir);
    expect(isYarnPnp({ versions: PLAIN_VERSIONS, cwd: dir })).toBe(true);
    expect(isYarnPnp({ versions: PLAIN_VERSIONS, cwd: sub })).toBe(true);
    expect(yarnPnpRefusal('test', { versions: PLAIN_VERSIONS, cwd: sub })?.code).toBe('YARN_PNP_UNSUPPORTED');
  });

  it('is false where tapsmith resolves from node_modules, despite a stray .pnp.cjs above', () => {
    const sub = writeProject(dir);
    const pkg = path.join(sub, 'node_modules', 'tapsmith');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{ "name": "tapsmith", "main": "index.js" }\n');
    fs.writeFileSync(path.join(pkg, 'index.js'), '');
    expect(isYarnPnp({ versions: PLAIN_VERSIONS, cwd: sub })).toBe(false);
  });

  // A `.pnp.cjs` left in a parent directory (a `yarn` run in $HOME) must not
  // turn `npx tapsmith test` in an npm project without tapsmith into a PnP refusal.
  it("is false when the nearest package.json doesn't declare tapsmith", () => {
    writeProject(dir);
    const app = path.join(dir, 'code', 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), '{ "dependencies": { "react": "19.0.0" } }\n');
    expect(isYarnPnp({ versions: PLAIN_VERSIONS, cwd: app })).toBe(false);
  });

  it('is false with no .pnp.cjs anywhere above', () => {
    expect(isYarnPnp({ versions: PLAIN_VERSIONS, cwd: dir })).toBe(false);
  });
});

describe('projectUsesYarnPnp() (PILOT-778)', () => {
  it('is true under Yarn\'s runtime, and for a project with its own .pnp.cjs before tapsmith is added', () => {
    expect(projectUsesYarnPnp(PNP())).toBe(true);
    expect(projectUsesYarnPnp(PLAIN())).toBe(false);
    fs.writeFileSync(path.join(dir, '.pnp.cjs'), '');
    expect(projectUsesYarnPnp(PLAIN())).toBe(true);
  });

  it('ignores a stray .pnp.cjs in a parent directory of a project that has not added tapsmith', () => {
    fs.writeFileSync(path.join(dir, '.pnp.cjs'), '');
    const project = path.join(dir, 'app');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), '{}');
    expect(projectUsesYarnPnp({ versions: PLAIN_VERSIONS, cwd: project })).toBe(false);
  });
});

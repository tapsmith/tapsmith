#!/usr/bin/env node
// Installs the packed tapsmith tarball into an empty project, the way a new
// user's first `npm install tapsmith` does, and fails on anything that makes
// that first install look broken or untrustworthy:
//
//   - an `npm warn deprecated` line for the dependency tree (PILOT-405);
//   - an install-scripts warning (`npm warn allow-scripts` on npm 11.17+,
//     `npm warn install-scripts` once npm 12 blocks them) naming a Tapsmith
//     package or a third-party package nobody has vetted (PILOT-437);
//   - a Tapsmith package that declares an install script at all, or a daemon
//     binary that is not executable straight from the tarball, with or without
//     `--ignore-scripts` (PILOT-437);
//   - compiled unit tests (`__tests__`) in the tarball (PILOT-438);
//   - an installed `tapsmith mcp-server` that cannot serve the
//     `tapsmith://api-reference` resource docs/agents.md points agents at,
//     because the build stopped bundling docs/api-reference.md (PILOT-359).
//
// The host platform's @tapsmith/core-* package is packed from npm-packages/
// with stub binaries in place of the Rust build, and @tapsmith/agent-android
// with stub APKs, so the check exercises this commit's package.json and file
// modes rather than the last published ones.
//
// Run after `npm run build`: `npm run check:clean-install`.
// Pass --keep to leave the scratch directory behind for inspection.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deprecationLines,
  disallowedInstallScripts,
  installScriptsOf,
  nonExecutableFiles,
  npmReportsInstallScripts,
  packEntry,
  parseInstallScriptWarnings,
  testPaths,
  undeclaredPlatformFields,
} from './clean-install-checks.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmPackagesDir = path.resolve(packageDir, '../../npm-packages');
const keep = process.argv.includes('--keep');

if (!fs.existsSync(path.join(packageDir, 'dist', 'cli.js'))) {
  console.error('check-clean-install: dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-clean-install-'));
// A fresh cache and empty user and global configs, so the result matches a
// first-time user's machine rather than whatever this one has cached or
// configured. The loglevel is pinned because the check reads warn lines: an
// inherited `npm run -s`, NPM_CONFIG_LOGLEVEL=error or a quiet npmrc would
// otherwise hide every warning and let the check pass vacuously.
const userConfig = path.join(scratch, 'user-npmrc');
const globalConfig = path.join(scratch, 'global-npmrc');
fs.writeFileSync(userConfig, '');
fs.writeFileSync(globalConfig, '');
// `npm run` exports every non-default setting of the caller's own npmrc as
// an npm_config_* variable, which the child npm reads back whatever userconfig
// it is given: color=always would break the line matching below, and
// allow-scripts or dangerously-allow-all-scripts would hide entries. Drop them
// all and set only what the check needs.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
);
const env = {
  ...inherited,
  npm_config_cache: path.join(scratch, 'cache'),
  npm_config_userconfig: userConfig,
  npm_config_globalconfig: globalConfig,
  npm_config_loglevel: 'warn',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_color: 'false',
  // Each install below says explicitly whether scripts run.
  npm_config_ignore_scripts: 'false',
};
// Resolution must find the installed platform package, not an override.
delete env.TAPSMITH_DAEMON_BIN;

function npm(args, cwd) {
  const result = spawnSync('npm', args, { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
}

const failures = [];
function fail(message) {
  failures.push(message);
  console.error(`\ncheck-clean-install: ${message}`);
}

function pack(dir) {
  const result = npm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], dir);
  if (result.status !== 0) {
    console.error(result.output);
    throw new Error(`npm pack failed in ${dir}`);
  }
  // stdout only: npm writes the JSON there and any warnings to stderr.
  const info = packEntry(result.stdout);
  return { ...info, tarball: path.join(scratch, info.filename) };
}

function emptyProject(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: `clean-install-${name}`, version: '0.0.0', private: true }, null, 2) + '\n',
  );
  return dir;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Steps ───

/** No package under npm-packages/ may declare an install script. */
function checkNoInstallScripts() {
  for (const entry of fs.readdirSync(npmPackagesDir, { withFileTypes: true })) {
    const pkgPath = path.join(npmPackagesDir, entry.name, 'package.json');
    if (!entry.isDirectory() || !fs.existsSync(pkgPath)) continue;
    const scripts = installScriptsOf(JSON.parse(fs.readFileSync(pkgPath, 'utf8')));
    if (scripts.length > 0) {
      fail(
        `npm-packages/${entry.name}/package.json declares ${scripts.join(', ')}. npm 11.17+ warns about it on every ` +
          'install and npm 12 blocks it. Ship what the script would produce in the tarball instead (file modes ' +
          'survive `npm pack` and install).',
      );
    }
  }
}

/**
 * No package under npm-packages/ may leave a platform field undeclared that
 * pnpm 11+ would infer from its name (PILOT-709).
 */
function checkDeclaredPlatforms() {
  for (const entry of fs.readdirSync(npmPackagesDir, { withFileTypes: true })) {
    const pkgPath = path.join(npmPackagesDir, entry.name, 'package.json');
    if (!entry.isDirectory() || !fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const fields = undeclaredPlatformFields(pkg);
    if (fields.length > 0) {
      fail(
        `npm-packages/${entry.name}/package.json does not declare ${fields.join(', ')}, which pnpm 11+ infers ` +
          `from the name ${pkg.name}. Declare the platforms it installs on.`,
      );
    }
  }
}

/** Pack tapsmith and fail on compiled tests; report the size. */
function packTapsmith() {
  const info = pack(packageDir);
  console.log(
    `check-clean-install: ${info.filename}: ${info.entryCount} files, ${formatBytes(info.size)} packed, ` +
      `${formatBytes(info.unpackedSize)} unpacked.`,
  );
  const tests = testPaths(info.files);
  if (tests.length > 0) {
    fail(
      `${info.filename} contains ${tests.length} compiled test file(s), e.g. ${tests.slice(0, 3).join(', ')}. ` +
        'The build must emit through tsconfig.build.json, which leaves src/__tests__ out.',
    );
  }
  return info;
}

/**
 * Pack the host platform's @tapsmith/core-* package from a copy whose binaries
 * are stub scripts, mode 0755 like the release workflow's `chmod +x`.
 */
function packHostCorePackage() {
  const name = `core-${process.platform}-${process.arch}`;
  const source = path.join(npmPackagesDir, name);
  if (!fs.existsSync(path.join(source, 'package.json'))) {
    throw new Error(`there is no npm-packages/${name}: Tapsmith ships the daemon for macOS and Linux only`);
  }
  const copy = path.join(scratch, name);
  fs.mkdirSync(copy);
  fs.copyFileSync(path.join(source, 'package.json'), path.join(copy, 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8'));
  const binaries = pkg.files;
  for (const bin of binaries) {
    fs.writeFileSync(path.join(copy, bin), `#!/bin/sh\necho "clean-install-stub ${bin}"\n`);
    fs.chmodSync(path.join(copy, bin), 0o755);
  }
  const info = pack(copy);
  const problems = nonExecutableFiles(info.files, binaries);
  if (problems.length > 0) {
    fail(`npm pack dropped the execute bit from ${pkg.name}'s binaries: ${problems.join(', ')}.`);
  }
  return { ...info, pkgName: pkg.name, binaries };
}

/** Pack @tapsmith/agent-android from a copy whose APKs are stub files. */
function packAgentAndroid() {
  const source = path.join(npmPackagesDir, 'agent-android');
  const copy = path.join(scratch, 'agent-android');
  fs.mkdirSync(copy);
  fs.copyFileSync(path.join(source, 'package.json'), path.join(copy, 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8'));
  for (const apk of pkg.files) fs.writeFileSync(path.join(copy, apk), 'clean-install-stub\n');
  return { ...pack(copy), pkgName: pkg.name };
}

/** Install with scripts, as a user does, and read npm's warnings. */
function checkInstallWarnings(tapsmith, core, npmVersion) {
  const project = emptyProject('with-scripts');
  const install = npm(['install', tapsmith.tarball, core.tarball], project);
  if (install.status !== 0) {
    console.error(install.output);
    fail(`npm install ${tapsmith.filename} failed (exit ${install.status}).`);
    return;
  }

  const deprecated = deprecationLines(install.output);
  if (deprecated.length > 0) {
    fail(
      `installing ${tapsmith.filename} into an empty project prints deprecation warnings:\n\n` +
        deprecated.map((line) => `  ${line}`).join('\n') +
        '\n\nEvery new user sees these on their first install. Upgrade or replace the dependency that pulls the\n' +
        'deprecated package in (`npm ls <name>` in packages/tapsmith shows the path).',
    );
  }

  if (!npmReportsInstallScripts(npmVersion)) {
    const message =
      `npm ${npmVersion} does not report install scripts (npm 11.17.0 is the first that does), so the ` +
      'install-scripts warning was not checked. Install npm 11.17 or later (`npm install -g npm@11.17.0`).';
    if (process.env.CI) fail(message);
    else console.warn(`\ncheck-clean-install: warning: ${message}`);
    return;
  }
  const { entries: reported, unrecognised } = parseInstallScriptWarnings(install.output);
  if (unrecognised.length > 0) {
    fail(
      `npm ${npmVersion} printed install-scripts warning lines this check cannot read:\n\n` +
        unrecognised.map((line) => `  ${line}`).join('\n') +
        '\n\nA multi-line install script, or a changed npm format. Update parseInstallScriptWarnings\n' +
        '(scripts/clean-install-checks.mjs) so these are checked rather than skipped.',
    );
  }
  const disallowed = disallowedInstallScripts(reported);
  if (disallowed.length > 0) {
    fail(
      `installing ${tapsmith.filename} prints an install-scripts warning for packages that are not allowed to ` +
        'have one:\n\n' +
        disallowed.map((entry) => `  ${entry.line}`).join('\n') +
        '\n\nA Tapsmith package must never need an install script. A new third-party one needs removing, or a\n' +
        'reason in ALLOWED_INSTALL_SCRIPTS (scripts/clean-install-checks.mjs) and in docs/getting-started.md.',
    );
  }
  const allowed = reported.filter((entry) => !disallowed.includes(entry)).map((entry) => entry.name);
  console.log(
    `check-clean-install: install scripts reported by npm ${npmVersion}: ` +
      (allowed.length > 0 ? `${allowed.join(', ')} (allowlisted).` : 'none.'),
  );
}

/**
 * Install with --ignore-scripts and prove the daemon binary is runnable and
 * found by the installed SDK on file modes alone.
 */
function checkBinariesWithoutScripts(tapsmith, core) {
  const project = emptyProject('ignore-scripts');
  const install = npm(['install', '--ignore-scripts', tapsmith.tarball, core.tarball], project);
  if (install.status !== 0) {
    console.error(install.output);
    fail(`npm install --ignore-scripts ${tapsmith.filename} failed (exit ${install.status}).`);
    return undefined;
  }
  const coreDir = path.join(project, 'node_modules', ...core.pkgName.split('/'));
  for (const bin of core.binaries) {
    const binPath = path.join(coreDir, bin);
    const run = spawnSync(binPath, [], { encoding: 'utf8' });
    if (run.error || run.status !== 0 || !run.stdout.includes(`clean-install-stub ${bin}`)) {
      const mode = fs.existsSync(binPath) ? (fs.statSync(binPath).mode & 0o777).toString(8) : 'missing';
      fail(
        `${core.pkgName}/${bin} does not run after \`npm install --ignore-scripts\` (mode ${mode}` +
          `${run.error ? `, ${run.error.message}` : ''}). npm installed a different copy or dropped the execute bit.`,
      );
    }
  }
  const resolve = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { findDaemonBin } = await import(${JSON.stringify(path.join(project, 'node_modules/tapsmith/dist/daemon-bin.js'))});` +
        'console.log(findDaemonBin());',
    ],
    { cwd: project, env, encoding: 'utf8' },
  );
  const expected = path.join(coreDir, 'tapsmith-core');
  const resolved = resolve.stdout.trim();
  const samePath = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.realpathSync.native(a) === fs.realpathSync.native(b);
  if (resolve.status !== 0 || !samePath(resolved, expected)) {
    fail(
      `the installed SDK's findDaemonBin() did not resolve ${core.pkgName}/tapsmith-core after ` +
        `\`npm install --ignore-scripts\`:\n${resolve.stdout}${resolve.stderr}`,
    );
  }
  return project;
}

/**
 * The installed package's MCP server must list and serve tapsmith://api-reference.
 * Only dist/ is published, so this fails if the build stops copying
 * docs/api-reference.md into it (PILOT-359). It uses the installed SDK and the
 * installed MCP SDK, in process, so it needs neither a daemon nor a device.
 * `project` is the --ignore-scripts install checkBinariesWithoutScripts made.
 */
function checkMcpApiReference(project) {
  const modules = path.join(project, 'node_modules');
  const script = `
    const { createMcpServer } = await import(${JSON.stringify(path.join(modules, 'tapsmith/dist/mcp/index.js'))});
    // Bare specifiers resolve from the project, so this is the MCP SDK the
    // installed tapsmith depends on.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'clean-install', version: '0.0.0' });
    await Promise.all([createMcpServer().connect(serverSide), client.connect(clientSide)]);
    if (!client.getServerCapabilities()?.resources) throw new Error('the server advertises no resources');
    const { resources } = await client.listResources();
    if (!resources.some((r) => r.uri === 'tapsmith://api-reference')) {
      throw new Error('resources/list has no tapsmith://api-reference: ' + JSON.stringify(resources.map((r) => r.uri)));
    }
    const { contents } = await client.readResource({ uri: 'tapsmith://api-reference' });
    const text = contents[0]?.text ?? '';
    if (!text.startsWith('# ')) throw new Error('resources/read returned no markdown: ' + JSON.stringify(text.slice(0, 80)));
    console.log(text.length);
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: project, env, encoding: 'utf8' });
  if (run.status !== 0) {
    fail(
      `the installed package's MCP server does not serve tapsmith://api-reference (docs/agents.md tells agents to ` +
        `read it). The build must copy docs/api-reference.md into dist/docs/:\n${run.stdout}${run.stderr}`,
    );
    return;
  }
  console.log(`check-clean-install: the installed MCP server serves tapsmith://api-reference (${run.stdout.trim()} chars).`);
}

// ─── pnpm (PILOT-709) ───

// pnpm 11 started inferring an optional dependency's platform from its name
// and skipped @tapsmith/agent-android; pnpm 10 did not, so it is not checked.
// Pinned so a pnpm release cannot turn this red without a change here.
const PNPM_VERSIONS = ['11.28.5', '12.11.2'];

/**
 * `pnpm add -D tapsmith` with each pinned pnpm (through corepack) must
 * install @tapsmith/agent-android, and the installed SDK must find its APKs.
 * Overrides point the Tapsmith packages at this commit's tarballs. Returns
 * whether pnpm was run at all.
 */
function checkPnpmInstallsAgent(tapsmith, core, agent) {
  const corepackEnv = {
    ...env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_STRICT: '0',
    COREPACK_HOME: path.join(scratch, 'corepack'),
  };
  const corepack = spawnSync('corepack', ['--version'], { env: corepackEnv, encoding: 'utf8' });
  if (corepack.error || corepack.status !== 0) {
    const message = 'corepack is not on PATH, so the pnpm install was not checked. It ships with Node 22 and 24.';
    if (process.env.CI) fail(message);
    else console.warn(`\ncheck-clean-install: warning: ${message}`);
    return false;
  }
  for (const version of PNPM_VERSIONS) {
    const project = emptyProject(`pnpm-${version}`);
    // allowBuilds: pnpm 11+ exits 1 over the build scripts it skipped
    // (esbuild, protobufjs) unless the project records a decision, which is
    // what docs/getting-started.md tells pnpm users to do.
    fs.writeFileSync(
      path.join(project, 'pnpm-workspace.yaml'),
      [
        'allowBuilds:',
        '  esbuild: false',
        '  protobufjs: false',
        'overrides:',
        `  '${agent.pkgName}': 'file:${agent.tarball}'`,
        `  '${core.pkgName}': 'file:${core.tarball}'`,
        '',
      ].join('\n'),
    );
    const install = spawnSync(
      'corepack',
      [`pnpm@${version}`, 'add', '-D', tapsmith.tarball, '--store-dir', path.join(scratch, 'pnpm-store')],
      { cwd: project, env: corepackEnv, encoding: 'utf8' },
    );
    if (install.error || install.status !== 0) {
      console.error(`${install.stdout ?? ''}${install.stderr ?? ''}`);
      fail(`pnpm ${version} add -D ${tapsmith.filename} failed (${install.error?.message ?? `exit ${install.status}`}).`);
      continue;
    }
    const resolve = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { findAgentApk, findAgentTestApk } = await import(${JSON.stringify(path.join(project, 'node_modules/tapsmith/dist/agent-resolve.js'))});` +
          'console.log(JSON.stringify([findAgentApk() ?? null, findAgentTestApk() ?? null]));',
      ],
      { cwd: project, env, encoding: 'utf8' },
    );
    let found = [];
    try {
      found = JSON.parse(resolve.stdout.trim());
    } catch {
      // Reported below.
    }
    const fromPackage = (p) => typeof p === 'string' && p.includes(path.join('@tapsmith', 'agent-android'));
    if (resolve.status !== 0 || found.length !== 2 || !found.every(fromPackage)) {
      fail(
        `after \`pnpm ${version} add -D tapsmith\`, the installed SDK does not find the Android agent APKs in ` +
          `${agent.pkgName} (pnpm skipped it, or it is not resolvable from tapsmith):\n${resolve.stdout}${resolve.stderr}`,
      );
      continue;
    }
    console.log(`check-clean-install: pnpm ${version} installs ${agent.pkgName} and the SDK finds its APKs.`);
  }
  return true;
}

// ─── Main ───

let exitCode = 0;
try {
  const npmVersion = npm(['--version'], scratch).stdout.trim();
  checkNoInstallScripts();
  checkDeclaredPlatforms();
  const tapsmith = packTapsmith();
  const core = packHostCorePackage();
  const agent = packAgentAndroid();
  checkInstallWarnings(tapsmith, core, npmVersion);
  const installed = checkBinariesWithoutScripts(tapsmith, core);
  if (installed) checkMcpApiReference(installed);
  const pnpmChecked = checkPnpmInstallsAgent(tapsmith, core, agent);
  if (failures.length > 0) {
    exitCode = 1;
  } else {
    console.log(
      `check-clean-install: ${tapsmith.filename} installs into an empty project with no deprecation warnings, ` +
        `no Tapsmith install scripts, a runnable daemon binary and its MCP API reference (npm ${npmVersion})` +
        (pnpmChecked ? `, and pnpm ${PNPM_VERSIONS.join(' and ')} install the Android agent.` : '.'),
    );
  }
} catch (err) {
  console.error(`check-clean-install: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  if (keep) console.log(`check-clean-install: scratch directory kept at ${scratch}`);
  else fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);

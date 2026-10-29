#!/usr/bin/env node

/**
 * The `tapsmith` bin. Checks the Node.js version before loading
 * the CLI, so an unsupported Node gets one clear line instead of a shebang
 * "bad option", a module link error or an unknown command.
 *
 * Its only static import is `node-runtime.js`, which imports nothing: every
 * static import is linked before any code here runs, so the CLI is loaded
 * dynamically, after the check.
 */

import { ignoreTypelessPackageWarnings, isSupportedNodeVersion, unsupportedNodeJson, unsupportedNodeMessage } from './node-runtime.js';

if (isSupportedNodeVersion(process.versions.node)) {
  ignoreTypelessPackageWarnings();
  await import('./cli.js');
} else {
  // exitCode, not exit(): stdout/stderr to a pipe is asynchronous on macOS, and
  // exit() can cut the message off.
  if (process.argv.slice(2).includes('--json')) process.stdout.write(unsupportedNodeJson(process.versions.node));
  else process.stderr.write(`${unsupportedNodeMessage(process.versions.node)}\n`);
  process.exitCode = 1;
}

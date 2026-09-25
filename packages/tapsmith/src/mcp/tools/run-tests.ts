import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ProjectInfo, TestDispatcher, TestResultEntry, TestTreeEntry } from '../test-dispatcher.js';
import { readTraceSummary } from './trace-utils.js';
import { getAllDaemonAddresses } from '../connection.js';
import { matchesTestFilter } from '../../test-filter.js';
import { getSessionResultsStore } from '../session-results.js';

/**
 * How often a running test suite reports progress to the MCP client. Clients
 * enforce an idle timeout on tool calls (Claude Code aborts after 300s without
 * output or progress), so a long run must emit `notifications/progress`
 * periodically or the call is killed client-side while the run continues
 * server-side (PILOT-285).
 */
const PROGRESS_INTERVAL_MS = 10_000;

let _running = false;

/**
 * The `tapsmith test` argv for a run without a dispatcher. The CLI has no
 * substring filter, so the `test` filter becomes a case-insensitive `--grep`
 * of the escaped literal, which selects the same tests as `matchesTestFilter`.
 * Values go in `=` form: a filter, project or serial may start with `-`.
 */
export function stdioTestArgs(opts: { files: string[]; testFilter?: string; project?: string; device?: string }): string[] {
  const args = ['test', ...opts.files, '--trace', 'on'];
  if (opts.testFilter) args.push(`--grep=/${opts.testFilter.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/i`);
  if (opts.project) args.push(`--project=${opts.project}`);
  if (opts.device) args.push(`--device=${opts.device}`);
  return args;
}

export function registerRunTestsTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_run_tests',
    'Run Tapsmith test files and return structured results. Reports pass/fail counts and detailed failure information including error messages and trace file paths for debugging. Only one test run can execute at a time. Use tapsmith_list_tests first to discover available files, test names, and project names.',
    {
      files: z.array(z.string()).describe('Absolute file paths or glob patterns (e.g. ["/Users/me/project/e2e/tests/login.test.ts"]). Use tapsmith_list_tests to find available files.'),
      test: z.string().optional().describe('Run only tests whose full name contains this text (case-insensitive substring of "Describe > test name", e.g. "submits form"). May match more than one test, and applies across all the given files. If it matches nothing, the run returns an error listing the available tests — it never silently passes. Use tapsmith_list_tests to see exact names.'),
      project: z.string().optional().describe('Project name to target a specific platform/device (e.g. "android", "ios"). Use tapsmith_list_tests to see available projects. Required when a requested file runs under more than one project — such a run is refused rather than sent to whichever project comes first. An unknown name is refused too, never ignored.'),
      device: z.string().optional().describe('Device serial, or a `use.devices` member name (e.g. "alice"), the run must use. Optional — prefer `project` to pick a platform. Never ignored: a session keeps its devices for its whole life, so this can confirm the device a run would use, or choose one on a headless session that has not run anything or used a device tool yet; any other device is refused, naming the one the session holds. UI mode accepts it only when a single worker of the files\' device target could take the run and holds that device.'),
    },
    async ({ files, test: testFilter, project, device }, extra) => {
      const sendProgress = makeProgressSender(extra);

      if (dispatcher) {
        // Dispatcher-backed mode: UI sessions and headless MCP both provide test management.
        if (dispatcher.isRunning()) {
          return {
            content: [{ type: 'text' as const, text: 'A test run is already in progress. Wait for it to finish or use tapsmith_stop_tests to abort.' }],
            isError: true,
          };
        }
        // First of all: the headless dispatcher can still pin an unresolved
        // target to `device` here, before the run resolves targets (and so
        // picks devices). A `device` it cannot honour is refused — ignoring it
        // ran the tests on whatever device the session held, another
        // session's included (PILOT-342).
        // An empty string is no device: some clients send one for an unset field.
        if (device) {
          const deviceError = await dispatcher.deviceChoiceError(files, device, project);
          if (deviceError) {
            return { content: [{ type: 'text' as const, text: deviceError }], isError: true };
          }
        }
        // Before the run, not inside it: a `project` that names nothing, or a
        // file that runs under several projects, decides *which device the
        // tests execute on*. Both dispatchers resolve those by falling back to
        // the first project holding the file, so the run passed on a platform
        // the caller never chose and the summary said nothing about it.
        const projectError = await validateProjectChoice(dispatcher, files, project);
        if (projectError) {
          return { content: [{ type: 'text' as const, text: projectError }], isError: true };
        }
        // Capture results of any run this tool didn't start (e.g. triggered
        // from the UI) into the session board before runFiles() resets them.
        const store = getSessionResultsStore(dispatcher);
        store.merge(dispatcher.getResults());

        sendProgress(`Started test run: ${files.length} file(s)`);
        const startedAt = Date.now();
        const heartbeat = setInterval(() => {
          const results = dispatcher.getResults();
          // Mid-run merge: keeps the session board complete even if the run
          // is later stopped or the results map is reset per-file.
          store.merge(results);
          sendProgress(formatRunProgress(results, Date.now() - startedAt));
        }, PROGRESS_INTERVAL_MS);
        heartbeat.unref?.();

        // Merge in finally so results recorded before a rejection still reach
        // the session board.
        const result = await dispatcher
          .runFiles(files, { testFilter, project })
          .finally(() => {
            clearInterval(heartbeat);
            store.merge(dispatcher.getResults());
          });
        const content: CallToolResult['content'] = [];
        const screenshots: Buffer[] = [];

        // Render per-failure details (steps, device logs, trace path) and
        // collect any failure screenshots. Shared by the stopped-with-failures
        // and failed branches.
        const appendFailureDetails = (lines: string[]): void => {
          if (!result.failures || result.failures.length === 0) return;
          for (const f of result.failures) {
            const proj = f.projectName ? ` [${f.projectName}]` : '';
            lines.push('');
            lines.push(`FAIL: ${f.fullName}${proj}`);
            lines.push(`  Error: ${f.error}`);
            if (f.tracePath) {
              const summary = readTraceSummary(f.tracePath);
              if (summary) {
                if (summary.steps.length > 0) {
                  lines.push('');
                  lines.push('  Steps leading to failure:');
                  for (const step of summary.steps) lines.push(`    ${step}`);
                }
                if (summary.deviceLogs.length > 0) {
                  lines.push('');
                  lines.push('  Device logs (errors/warnings):');
                  for (const log of summary.deviceLogs) lines.push(`    ${log}`);
                }
                if (summary.failureScreenshot) screenshots.push(summary.failureScreenshot);
              }
              lines.push(`  Trace: ${f.tracePath}`);
            }
          }
        };
        const pushScreenshots = (): void => {
          for (const img of screenshots) {
            content.push({ type: 'image' as const, data: img.toString('base64'), mimeType: 'image/png' });
          }
        };

        const ran = result.passed + result.failed;

        if (result.status === 'stopped') {
          // User-requested stop: report partial results (not an error).
          const interrupted = result.interrupted ? `, ${result.interrupted} interrupted` : '';
          const lines: string[] = [
            result.failed > 0
              ? `Run stopped by user — partial results: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped${interrupted} (${result.duration}ms)`
              : `Run stopped by user — partial results: ${result.passed} passed, ${result.skipped} skipped${interrupted} (${result.duration}ms)`,
          ];
          appendFailureDetails(lines);
          content.push({ type: 'text' as const, text: lines.join('\n') });
          pushScreenshots();
          return { content };
        }

        if (testFilter && ran === 0) {
          // A test filter was supplied but nothing ran. Never report this as a
          // pass — surface an actionable error so the caller can correct it.
          return {
            content: [{ type: 'text' as const, text: buildZeroMatchMessage(dispatcher, files, testFilter) }],
            isError: true,
          };
        }

        if (result.failed > 0 || result.status === 'failed') {
          const lines: string[] = [
            result.failed > 0
              ? `Tests failed: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.duration}ms)`
              : buildNoTestsExecutedMessage(dispatcher, files, result.passed, result.skipped, result.duration),
          ];
          appendFailureDetails(lines);
          // A session with no config has no app to launch, so every run here
          // fails for a reason that has nothing to do with the tests.
          const configWarning = dispatcher.getSessionInfo().configWarning;
          if (configWarning) {
            lines.push('');
            lines.push(`NOTE: ${configWarning}`);
          }
          content.push({ type: 'text' as const, text: lines.join('\n') });
          pushScreenshots();
          return { content, isError: true };
        }

        content.push({
          type: 'text' as const,
          text: testFilter
            ? `All tests passed: ${result.passed} passed matching "${testFilter}" (${result.duration}ms)`
            : `All tests passed: ${result.passed} passed, ${result.skipped} skipped (${result.duration}ms)`,
        });
        return { content };
      }

      // Stdio mode: spawn tapsmith test subprocess
      if (_running) {
        return {
          content: [{ type: 'text' as const, text: 'A test run is already in progress. Wait for it to finish before starting another.' }],
          isError: true,
        };
      }

      _running = true;
      try {
        const args = stdioTestArgs({ files, testFilter, project, device });

        sendProgress(`Started test run: ${files.length} file(s)`);
        const startedAt = Date.now();
        let lastLine = '';
        const heartbeat = setInterval(() => {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          sendProgress(lastLine ? `Running for ${elapsed}s — ${lastLine}` : `Running for ${elapsed}s`);
        }, PROGRESS_INTERVAL_MS);
        heartbeat.unref?.();

        const result = await runTapsmithProcess(args, (line) => { lastLine = line; })
          .finally(() => clearInterval(heartbeat));
        return { content: [{ type: 'text' as const, text: result }] };
      } finally {
        _running = false;
      }
    },
  );
}

/**
 * Build a `notifications/progress` sender for this request. No-op when the
 * client didn't ask for progress (no `progressToken` in the request `_meta`).
 * Send failures are swallowed — a dropped client must not kill the test run.
 */
function makeProgressSender(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): (message: string) => void {
  const progressToken = extra._meta?.progressToken;
  // The spec requires `progress` to increase with each notification; the
  // human-readable state lives in `message`, so a plain sequence number is
  // enough (there is no meaningful `total` to report).
  let progressSeq = 0;
  return (message: string): void => {
    if (progressToken === undefined) return;
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: ++progressSeq, message },
      })
      .catch(() => { /* client gone or transport closed */ });
  };
}

/**
 * Why the `project` argument cannot stand as given, or null when it can.
 *
 * Both dispatchers pick a project for a file by name first and by "the first
 * project whose files include it" second, and neither step can fail: an
 * unknown name silently falls through to the file match, and a file belonging
 * to several projects silently takes the first. In a multi-platform config
 * both mean the run lands on a device the caller did not choose — and reports
 * "All tests passed" without naming it. The check lives here so both
 * transports answer the same way, next to the other argument validation.
 *
 * @internal — exported for unit testing.
 */
export async function validateProjectChoice(
  dispatcher: TestDispatcher,
  files: string[],
  project?: string,
): Promise<string | null> {
  // A project's `testFiles` are only populated once discovery has run; without
  // this the check reads an empty project list and passes everything.
  await dispatcher.ensureInitialized?.();
  const projects = dispatcher.getSessionInfo().projects;

  if (project !== undefined) {
    if (projects.some((p) => p.name === project)) return null;
    const known = projects.map((p) => p.name).join(', ');
    return `Unknown project "${project}". `
      + (known
        ? `This config declares: ${known}. Use tapsmith_list_tests to see which files each one runs.`
        : 'This config declares no projects, so `project` cannot select anything — omit it.');
  }

  // No project named: only a file that runs under more than one is ambiguous.
  const resolve = dispatcher.resolveRequestedFiles;
  const requested = resolve ? resolve.call(dispatcher, files) : files;
  const ambiguous = requested
    .map((file) => ({ file, owners: projects.filter((p) => p.testFiles.includes(file)) }))
    .filter((entry) => entry.owners.length > 1);
  if (ambiguous.length === 0) return null;

  const lines = ambiguous.map(
    (entry) => `  ${entry.file}\n    runs under: ${entry.owners.map(describeProjectOwner).join(', ')}`,
  );
  return 'This run needs a `project`: the requested file(s) run under more than one.\n'
    + `${lines.join('\n')}\n\n`
    + 'Pass `project` with one of the names above to say which device the tests should run on.';
}

function describeProjectOwner(project: ProjectInfo): string {
  return project.platform ? `${project.name} (${project.platform})` : project.name;
}

/** One-line live summary of an in-flight run for progress notifications. */
function formatRunProgress(results: TestResultEntry[], elapsedMs: number): string {
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const done = passed + failed + skipped;
  const elapsed = Math.round(elapsedMs / 1000);
  const parts = [`${passed} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${done} test(s) finished (${parts.join(', ')}) after ${elapsed}s`;
}

/** Flatten the dispatcher's test tree into its `type: 'test'` leaf nodes. */
function flattenTestNodes(nodes: TestTreeEntry[], out: TestTreeEntry[] = []): TestTreeEntry[] {
  for (const node of nodes) {
    if (node.type === 'test') out.push(node);
    if (node.children) flattenTestNodes(node.children, out);
  }
  return out;
}

/**
 * Build an actionable error message for a `test` filter that ran nothing:
 * distinguishes an unknown/empty file, a typo'd filter (lists candidates), and
 * a filter that matched only `.skip()`'d tests.
 */
/**
 * Explain a run that executed nothing. "No tests executed" alone is ambiguous:
 * it reads the same whether the paths matched nothing or matched files with no
 * tests. Name the arguments that matched nothing so the caller can fix them.
 */
function buildNoTestsExecutedMessage(
  dispatcher: TestDispatcher,
  files: string[],
  passed: number,
  skipped: number,
  duration: number,
): string {
  const summary = `Test run failed — no tests executed (${passed} passed, ${skipped} skipped, ${duration}ms).`;
  // A whole-suite run supplied no paths, so there is nothing to blame on the
  // arguments — saying "the file(s) were found but contained no tests" invents
  // files the caller never named.
  if (files.length === 0) {
    return `${summary} The session discovered no runnable tests — use tapsmith_list_tests to see what it found, `
      + 'including any file that failed to load.';
  }
  const resolve = dispatcher.resolveRequestedFiles;
  if (!resolve) {
    return `${summary} Check that the requested file path(s) exist and were discovered (use tapsmith_list_tests).`;
  }

  const unmatched = files.filter((f) => resolve.call(dispatcher, [f]).length === 0);
  if (unmatched.length === 0) {
    return `${summary} The file(s) were found but contained no runnable tests — use tapsmith_list_tests to see what they hold.`;
  }
  return `${summary} These argument(s) matched no discovered test file:\n`
    + unmatched.map((f) => `  - ${f}`).join('\n')
    + '\n\nPaths may be absolute, relative to the project root, or globs. '
    + 'Use tapsmith_list_tests for the exact paths — and note that a file which failed to load is reported there as a warning rather than listed.';
}

function buildZeroMatchMessage(dispatcher: TestDispatcher, files: string[], testFilter: string): string {
  // Resolve first: `files` may hold relative paths or globs, and comparing
  // those to absolute discovered paths finds nothing — so a run whose *filter*
  // matched no test would blame the path instead of listing the test names.
  const resolved = dispatcher.resolveRequestedFiles?.(files) ?? files;
  const inFiles = flattenTestNodes(dispatcher.getTestTree()).filter((t) => resolved.includes(t.filePath));
  if (inFiles.length === 0) {
    return `No tests were found in the requested file(s): ${files.join(', ')}. Check the path(s) are correct and were discovered — run tapsmith_list_tests to see available files and tests.`;
  }
  const matched = inFiles.filter((t) => matchesTestFilter(t.fullName, testFilter));
  if (matched.length === 0) {
    const list = inFiles.map((t) => `  - "${t.fullName}"`).join('\n');
    return `No test matched "${testFilter}". The "test" argument is a case-insensitive substring of the full test name.\nAvailable tests:\n${list}\n\nPass one of these names (or a substring of one) as "test", or omit "test" to run the whole file.`;
  }
  const list = matched.map((t) => `  - "${t.fullName}"`).join('\n');
  return `"${testFilter}" matched ${matched.length} test(s), but they are all marked .skip() so nothing ran:\n${list}`;
}

function runTapsmithProcess(args: string[], onOutputLine?: (line: string) => void): Promise<string> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      FORCE_COLOR: '0',
      TAPSMITH_REUSE_DAEMON: '1',
    };
    const daemonAddr = getAllDaemonAddresses();
    if (daemonAddr) env.TAPSMITH_DAEMON_ADDRESS = daemonAddr;

    const child = spawn(process.execPath, [process.argv[1], ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    // Only complete lines are reported as progress; a line straddling two
    // chunks is carried over rather than emitted as garbled fragments.
    let pendingLine = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (onOutputLine) {
        pendingLine += text;
        const parts = pendingLine.split('\n');
        pendingLine = parts.pop() ?? '';
        const complete = parts.map((l) => l.trim()).filter((l) => l.length > 0);
        if (complete.length > 0) onOutputLine(complete[complete.length - 1]);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
      if (code !== 0) {
        resolve(`Tests failed (exit code ${code}):\n${output}`);
      } else {
        resolve(output || 'All tests passed.');
      }
    });

    child.on('error', (err) => {
      resolve(`Failed to run tapsmith: ${err.message}`);
    });
  });
}

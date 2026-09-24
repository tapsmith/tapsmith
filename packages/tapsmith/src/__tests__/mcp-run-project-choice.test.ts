import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerRunTestsTool, validateProjectChoice } from '../mcp/tools/run-tests.js';
import type { ProjectInfo, TestDispatcher } from '../mcp/test-dispatcher.js';

// Which project a run belongs to decides which *device* it executes on. Both
// dispatchers resolve it name-first, file-second, and neither step could fail:
// an unknown name fell through to the file match, and a file belonging to two
// projects took whichever was declared first. On a multi-platform config that
// meant `run_tests` answered "All tests passed" for a platform the caller never
// chose — and never said which one it had picked.

type ToolCallback = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

const extra = { _meta: undefined, sendNotification: async (): Promise<void> => {} };

const HOME = '/repo/e2e/tests/home.test.ts';
const AUTH = '/repo/e2e/tests/auth.setup.ts';

function project(name: string, platform: string | undefined, testFiles: string[]): ProjectInfo {
  return { name, platform, testFiles, dependencies: [] };
}

/** A dispatcher whose runs are observable, so a refusal can be told from a run. */
function makeDispatcher(projects: ProjectInfo[]): {
  dispatcher: TestDispatcher
  runs: Array<{ files: string[]; project?: string }>
} {
  const runs: Array<{ files: string[]; project?: string }> = [];
  const known = [...new Set(projects.flatMap((p) => p.testFiles))];
  const dispatcher: TestDispatcher = {
    runFiles: async (files, options) => {
      runs.push({ files, project: options?.project });
      return { status: 'passed', passed: 1, failed: 0, skipped: 0, duration: 5 };
    },
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => known,
    getProjects: () => projects.map((p) => p.name),
    getTestTree: () => [],
    resolveRequestedFiles: (files) => files.filter((f) => known.includes(f)),
    getSessionInfo: () => ({ timeout: 0, retries: 0, projects }),
    resolveDeviceName: () => undefined,
    deviceChoiceError: async () => null,
    toggleWatch: () => ({ enabled: false }),
  };
  return { dispatcher, runs };
}

function runTool(dispatcher: TestDispatcher): ToolCallback {
  const tools = new Map<string, ToolCallback>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, cb: ToolCallback): void => { tools.set(name, cb); },
  } as unknown as McpServer;
  registerRunTestsTool(server, dispatcher);
  return tools.get('tapsmith_run_tests')!;
}

const MULTI_PLATFORM = [
  project('android', 'android', [HOME, AUTH]),
  project('ios', 'ios', [HOME]),
];

const SINGLE_PLATFORM = [
  project('authentication', 'ios', [AUTH]),
  project('default', 'ios', [HOME]),
];

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n');
}

describe('validateProjectChoice', () => {
  it('refuses a file that runs under more than one project', async () => {
    const { dispatcher } = makeDispatcher(MULTI_PLATFORM);
    const msg = await validateProjectChoice(dispatcher, [HOME]);
    expect(msg).toContain('needs a `project`');
    // Both candidates named, with the platform that makes the choice matter.
    expect(msg).toContain('android (android)');
    expect(msg).toContain('ios (ios)');
  });

  it('accepts that same file once a project says which one', async () => {
    const { dispatcher } = makeDispatcher(MULTI_PLATFORM);
    expect(await validateProjectChoice(dispatcher, [HOME], 'ios')).toBeNull();
  });

  it('accepts a file that only one project runs', async () => {
    const { dispatcher } = makeDispatcher(MULTI_PLATFORM);
    expect(await validateProjectChoice(dispatcher, [AUTH])).toBeNull();
  });

  // The single-platform case is the common one, and nothing about it is
  // ambiguous — every project runs on the same device.
  it('leaves a single-platform config alone', async () => {
    const { dispatcher } = makeDispatcher(SINGLE_PLATFORM);
    expect(await validateProjectChoice(dispatcher, [HOME, AUTH])).toBeNull();
  });

  it('refuses a project the config does not declare, and lists what it does', async () => {
    const { dispatcher } = makeDispatcher(MULTI_PLATFORM);
    const msg = await validateProjectChoice(dispatcher, [HOME], 'iOS');
    expect(msg).toContain('Unknown project "iOS"');
    expect(msg).toContain('android, ios');
  });

  it('says a config declares no projects rather than ignoring the argument', async () => {
    const { dispatcher } = makeDispatcher([]);
    const msg = await validateProjectChoice(dispatcher, [HOME], 'ios');
    expect(msg).toContain('declares no projects');
  });

  // Only the files that actually resolve are judged: an argument matching
  // nothing has its own message, and reporting it as ambiguous would hide that.
  it('ignores arguments that match no discovered file', async () => {
    const { dispatcher } = makeDispatcher(MULTI_PLATFORM);
    expect(await validateProjectChoice(dispatcher, ['/repo/e2e/tests/nope.test.ts'])).toBeNull();
  });

  it('waits for discovery before judging, or every project looks empty', async () => {
    const { dispatcher } = makeDispatcher(MULTI_PLATFORM);
    let initialized = false;
    const lazy: TestDispatcher = {
      ...dispatcher,
      ensureInitialized: async () => { initialized = true; },
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: initialized ? MULTI_PLATFORM : [],
      }),
    };
    expect(await validateProjectChoice(lazy, [HOME])).toContain('needs a `project`');
  });
});

describe('tapsmith_run_tests project routing', () => {
  it('refuses the run instead of picking the first project', async () => {
    const { dispatcher, runs } = makeDispatcher(MULTI_PLATFORM);
    const result = await runTool(dispatcher)({ files: [HOME] }, extra);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('needs a `project`');
    // The point of the guard: nothing ran on a device nobody chose.
    expect(runs).toEqual([]);
  });

  it('runs it once the caller names a project', async () => {
    const { dispatcher, runs } = makeDispatcher(MULTI_PLATFORM);
    const result = await runTool(dispatcher)({ files: [HOME], project: 'ios' }, extra);

    expect(result.isError).toBeFalsy();
    expect(runs).toEqual([{ files: [HOME], project: 'ios' }]);
  });

  it('refuses an unknown project rather than running under another one', async () => {
    const { dispatcher, runs } = makeDispatcher(MULTI_PLATFORM);
    const result = await runTool(dispatcher)({ files: [HOME], project: 'no-such-project' }, extra);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown project "no-such-project"');
    expect(runs).toEqual([]);
  });

  it('still runs an unambiguous file with no project argument', async () => {
    const { dispatcher, runs } = makeDispatcher(SINGLE_PLATFORM);
    const result = await runTool(dispatcher)({ files: [HOME] }, extra);

    expect(result.isError).toBeFalsy();
    expect(runs).toEqual([{ files: [HOME], project: undefined }]);
  });
});

// PILOT-342: `device` was forwarded only on the CLI fallback branch, so a
// dispatcher-backed run went to whichever device the session held. The tool
// now asks the dispatcher first, and a refusal stops the run.
describe('run_tests `device`', () => {
  it('refuses the run with the dispatcher\'s reason, running nothing', async () => {
    const { dispatcher, runs } = makeDispatcher(SINGLE_PLATFORM);
    const asked: Array<{ files: string[]; device: string; project?: string }> = [];
    dispatcher.deviceChoiceError = async (files, device, project) => {
      asked.push({ files, device, project });
      return 'This session runs android tests on emulator-5556, not emulator-5560.';
    };
    const result = await runTool(dispatcher)({ files: [HOME], device: 'emulator-5560', project: 'default' }, extra);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not emulator-5560');
    expect(asked).toEqual([{ files: [HOME], device: 'emulator-5560', project: 'default' }]);
    expect(runs).toEqual([]);
  });

  it('runs when the dispatcher can honour it', async () => {
    const { dispatcher, runs } = makeDispatcher(SINGLE_PLATFORM);
    const result = await runTool(dispatcher)({ files: [HOME], device: 'emulator-5560' }, extra);
    expect(result.isError).toBeUndefined();
    expect(runs).toHaveLength(1);
  });

  // The headless dispatcher pins an unresolved target while answering, so the
  // question must come before anything that initializes the session (which
  // auto-picks a device first).
  it('asks before anything initializes the session', async () => {
    const { dispatcher } = makeDispatcher(SINGLE_PLATFORM);
    const order: string[] = [];
    dispatcher.ensureInitialized = async () => { order.push('init'); };
    dispatcher.deviceChoiceError = async () => { order.push('device'); return null; };
    await runTool(dispatcher)({ files: [HOME], device: 'emulator-5560' }, extra);
    expect(order[0]).toBe('device');
  });

  it('treats an empty device as none', async () => {
    const { dispatcher, runs } = makeDispatcher(SINGLE_PLATFORM);
    let asked = false;
    dispatcher.deviceChoiceError = async () => { asked = true; return 'refused'; };
    await runTool(dispatcher)({ files: [HOME], device: '' }, extra);
    expect(asked).toBe(false);
    expect(runs).toHaveLength(1);
  });

  it('does not ask when no device is given', async () => {
    const { dispatcher } = makeDispatcher(SINGLE_PLATFORM);
    let asked = false;
    dispatcher.deviceChoiceError = async () => { asked = true; return null; };
    await runTool(dispatcher)({ files: [HOME] }, extra);
    expect(asked).toBe(false);
  });
});

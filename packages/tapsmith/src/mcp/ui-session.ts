import * as fs from 'node:fs';
import * as path from 'node:path';
import { allUiPortFiles } from './port-file.js';

// ─── Types ───

/** The project a UI-mode session was started for, as it publishes it. */
export interface UiSessionProject {
  /** The directory `tapsmith test --ui` was started in. */
  cwd: string
  /** The config's `rootDir`. */
  rootDir?: string
  /** The config file, absent for a session on built-in defaults. */
  configPath?: string
}

/** A running UI-mode session an MCP server of the same project can work in. */
export interface UiSession {
  /** Its Streamable-HTTP MCP endpoint. */
  mcpUrl: string
  project: UiSessionProject
  pid?: number
  /** ISO time the session started. */
  startedAt?: string
}

/** Whose UI session to look for. */
export interface ProjectRef {
  /** The directory the MCP server runs in. */
  cwd: string
  /** Its `--config` file, when it was given one. */
  configFile?: string
}

// ─── Matching ───

/** `dir` with symlinks resolved (macOS `/tmp`, a linked checkout), or as given when it does not exist. */
function realDir(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function folders(dirs: Array<string | undefined>): Set<string> {
  return new Set(dirs.filter((d): d is string => Boolean(d)).map(realDir));
}

function configPathOf(ref: ProjectRef): string | undefined {
  return ref.configFile ? realDir(path.resolve(ref.cwd, ref.configFile)) : undefined;
}

/**
 * Whether a UI session belongs to the project `mine` runs in: they share a
 * folder among the directory each was started in, the session's `rootDir`
 * and the directory of either's config file. So a session started from a
 * repo root with `-c e2e/tapsmith.config.ts` is the one an agent working in
 * `e2e/` wants, and a session of the project next door is not.
 */
export function uiSessionMatchesProject(project: UiSessionProject, mine: ProjectRef): boolean {
  const myConfig = configPathOf(mine);
  const theirs = folders([project.cwd, project.rootDir, project.configPath && path.dirname(project.configPath)]);
  const ours = folders([mine.cwd, myConfig && path.dirname(myConfig)]);
  return [...ours].some((dir) => theirs.has(dir));
}

/**
 * The session to work in when several of the project's are running (an iOS
 * and an Android one, say): the one on the same config file as `mine`, else
 * the one started last.
 */
export function chooseUiSession(sessions: UiSession[], mine: ProjectRef): UiSession | undefined {
  const matching = sessions.filter((s) => uiSessionMatchesProject(s.project, mine));
  if (matching.length <= 1) return matching[0];
  const myConfig = configPathOf(mine);
  const sameConfig = myConfig
    ? matching.filter((s) => s.project.configPath && realDir(s.project.configPath) === myConfig)
    : [];
  const pool = sameConfig.length > 0 ? sameConfig : matching;
  return [...pool].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
}

// ─── Discovery ───

const QUERY_TIMEOUT_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/**
 * The session a UI server's `/api/daemon-ports` answer describes, or
 * undefined when it names no project (a UI server that predates the field,
 * or something else answering on a port a dead session left behind).
 *
 * @internal — exported for unit testing.
 */
export function parseUiSession(data: unknown, port: number): UiSession | undefined {
  if (!isRecord(data) || !isRecord(data.project)) return undefined;
  const cwd = optionalString(data.project.cwd);
  if (!cwd) return undefined;
  return {
    // The port the answer came from, not a URL taken from the answer: it is
    // the one address known to be this session's.
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    project: { cwd, rootDir: optionalString(data.project.rootDir), configPath: optionalString(data.project.configPath) },
    pid: typeof data.pid === 'number' ? data.pid : undefined,
    startedAt: optionalString(data.startedAt),
  };
}

/** GET a UI server's `/api/daemon-ports`: its answer, or why there is none. */
async function askUiServer(port: number, timeoutMs: number): Promise<{ data: unknown } | 'refused' | 'unanswered'> {
  // Twice: a kept-alive connection to a server that has since exited fails on
  // its first use (ECONNRESET), and only the next attempt, on a new
  // connection, says whether anything still listens.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/daemon-ports`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return 'refused';
      return { data: await res.json() };
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') return 'unanswered';
      if (attempt > 0) return 'refused';
    }
  }
}

async function queryUiSession(portFile: string, timeoutMs: number): Promise<UiSession | undefined> {
  let port: number;
  try {
    port = Number.parseInt((await fs.promises.readFile(portFile, 'utf-8')).trim(), 10);
  } catch {
    return undefined;
  }
  if (!Number.isFinite(port) || port <= 0) return undefined;
  // Nothing listening (a port file a killed session left), no answer in time,
  // or not a UI server's answer.
  const answer = await askUiServer(port, timeoutMs);
  return typeof answer === 'string' ? undefined : parseUiSession(answer.data, port);
}

/**
 * Whether `session` is still running: `gone` when nothing answers on its port
 * or another session does, `unanswered` when its server is there but did not
 * answer in time (busy, not gone).
 */
export async function probeUiSession(session: UiSession, timeoutMs: number = QUERY_TIMEOUT_MS): Promise<'alive' | 'gone' | 'unanswered'> {
  const port = Number.parseInt(new URL(session.mcpUrl).port, 10);
  const answer = await askUiServer(port, timeoutMs);
  if (answer === 'unanswered') return 'unanswered';
  if (answer === 'refused') return 'gone';
  const now = parseUiSession(answer.data, port);
  return now && now.pid === session.pid && now.startedAt === session.startedAt ? 'alive' : 'gone';
}

/**
 * The running UI-mode session of the project `mine` runs in, if any.
 *
 * Every UI server on the machine is asked, not just the one whose port file
 * is named after this directory: the file is keyed by the directory the
 * session was started in, which need not be the agent's.
 */
export async function findUiSession(
  mine: ProjectRef,
  opts: { portFiles?: string[]; timeoutMs?: number } = {},
): Promise<UiSession | undefined> {
  const files = opts.portFiles ?? allUiPortFiles();
  if (files.length === 0) return undefined;
  const found = await Promise.all(files.map((f) => queryUiSession(f, opts.timeoutMs ?? QUERY_TIMEOUT_MS)));
  return chooseUiSession(found.filter((s): s is UiSession => s !== undefined), mine);
}

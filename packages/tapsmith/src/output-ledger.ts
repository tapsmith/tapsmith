/**
 * What each run wrote into `outputDir`, so the next run can remove it.
 *
 * Playwright empties its `outputDir` at the start of a run. Tapsmith's holds
 * files that must survive: the guides keep saved app state there, CI drops
 * logs there, and a user may point it at a folder of their own. So nothing is
 * removed because of where it is or what it is called: each run records the
 * files it writes in a ledger, `<outputDir>/.tapsmith-output/<run>.jsonl`, and
 * a run starts by removing the recorded files of the runs that are over. A
 * file no ledger names, or one that has changed since it was recorded, is left
 * alone, and so is everything a run that is still going has written.
 *
 * A run is one top-level process (a `tapsmith test`, a UI or watch session, an
 * MCP server). It stamps its identity into the environment, so the workers it
 * forks record into the same ledger.
 *
 * Best-effort throughout: a ledger that cannot be read or written never fails
 * a run; the files are then left behind.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { processIsLive, thisProcess, type ProcessRef } from './device-claims.js';

const LEDGER_DIR = '.tapsmith-output';
/** Carries the run's identity from its root process to everything it forks. */
const RUN_ENV = 'TAPSMITH_OUTPUT_RUN';
/** Internal: set by a command whose `tapsmith test` child is a check, not the user's run. */
export const KEEP_OUTPUT_ENV = 'TAPSMITH_KEEP_OUTPUT';
/**
 * How long a run of another machine or container, which left no end mark, is
 * taken to be still going: its process cannot be looked up from here.
 */
const FOREIGN_RUN_MS = 24 * 60 * 60 * 1000;

interface OutputRun {
  id: string
  host: string
  owner: ProcessRef
  /** The one directory the run's files are recorded for. */
  outputDir: string
}

/** The parts of the config that say where output goes. */
interface OutputConfig {
  rootDir: string
  outputDir: string
}

function resolveOutputDir(config: OutputConfig): string | undefined {
  // Reporters may be handed a partial config by an embedder.
  if (typeof config.outputDir !== 'string') return undefined;
  return path.resolve(config.rootDir ?? process.cwd(), config.outputDir);
}

// ─── Recording ───

/**
 * Start a run: what it writes from here on is recorded as its own, in this
 * process and everything it forks. With `clear`, the output of the runs before
 * it is removed first. Call once the command is known to run, and before any
 * child is forked.
 */
export function beginOutputRun(config: OutputConfig, opts: { clear: boolean }): void {
  const outputDir = resolveOutputDir(config);
  if (!outputDir) return;
  if (opts.clear && process.env[KEEP_OUTPUT_ENV] !== '1') clearPreviousOutput(outputDir);
  const run: OutputRun = { id: randomUUID(), host: processHost(), owner: thisProcess(), outputDir };
  process.env[RUN_ENV] = JSON.stringify(run);
  process.once('exit', () => endRun(run));
}

/** Record that this run wrote `file`, if it is in `outputDir`. */
export function recordOutputFile(config: OutputConfig | undefined, file: string): void {
  const outputDir = config && resolveOutputDir(config);
  if (!outputDir) return;
  const run = currentRun();
  if (!run || run.outputDir !== outputDir) return;
  const rel = path.relative(outputDir, path.resolve(file));
  if (rel === '' || rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) return;
  try {
    const { size, mtimeMs } = fs.statSync(file);
    const ledger = ledgerPath(run);
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    // One append, so the workers of a run never split each other's lines. The
    // owner goes with every entry: whichever process writes first, the run can
    // be recognised as live from its first entry.
    fs.appendFileSync(ledger, JSON.stringify({ host: run.host, owner: run.owner, file: rel.split(path.sep).join('/'), size, mtimeMs }) + '\n');
  } catch {
    // Left behind rather than failing the test that produced it.
  }
}

/**
 * Where a pid means the same process: the machine and, on Linux, the pid
 * namespace, since containers can share a hostname.
 */
function processHost(): string {
  try {
    return `${os.hostname()} ${fs.readlinkSync('/proc/self/ns/pid')}`;
  } catch {
    return os.hostname(); // no procfs (macOS, Windows): one namespace
  }
}

function currentRun(): OutputRun | undefined {
  const raw = process.env[RUN_ENV];
  if (!raw) return undefined;
  try {
    const run: unknown = JSON.parse(raw);
    if (isRecord(run) && typeof run.id === 'string' && typeof run.host === 'string'
      && typeof run.outputDir === 'string' && isProcessRef(run.owner)) return run as unknown as OutputRun;
  } catch {
    // Not a run identity.
  }
  return undefined;
}

function ledgerPath(run: OutputRun): string {
  return path.join(run.outputDir, LEDGER_DIR, `${run.id}.jsonl`);
}

/** Says the run is over where its process cannot be looked up (another container), or its pid has been reused. */
function endRun(run: OutputRun): void {
  try {
    const ledger = ledgerPath(run);
    if (fs.existsSync(ledger)) fs.appendFileSync(ledger, JSON.stringify({ end: true }) + '\n');
  } catch {
    // Its dead process says so too.
  }
}

// ─── Clearing ───

function clearPreviousOutput(outputDir: string): void {
  const dir = path.join(outputDir, LEDGER_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return; // no run has written here
  }
  for (const name of names) {
    const ledger = path.join(dir, name);
    try {
      const { files, over } = readLedger(ledger);
      if (!over) continue;
      let removedAll = true;
      for (const [file, stamp] of files) removedAll = removeRecorded(outputDir, file, stamp) && removedAll;
      // Kept while a file could not be removed, for the next run to retry.
      if (removedAll) fs.rmSync(ledger, { force: true });
    } catch {
      // Unreadable: leave the run's files alone.
    }
  }
}

/** What a file looked like when it was recorded. */
interface FileStamp {
  size: number
  mtimeMs: number
}

function readLedger(ledger: string): { files: Map<string, FileStamp>; over: boolean } {
  const files = new Map<string, FileStamp>();
  let live = false;
  let ended = false;
  for (const line of fs.readFileSync(ledger, 'utf-8').split('\n')) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // blank, or cut short by a crash
    }
    if (!isRecord(entry)) continue;
    if (entry.end === true) ended = true;
    if (typeof entry.file !== 'string' || typeof entry.size !== 'number' || typeof entry.mtimeMs !== 'number'
      || !isProcessRef(entry.owner)) continue;
    // The last entry wins: a trace is recorded again when hooks amend it.
    files.set(entry.file, { size: entry.size, mtimeMs: entry.mtimeMs });
    if (files.size > 1) continue; // every entry has the same owner
    live = entry.host === processHost()
      ? processIsLive(entry.owner)
      : Date.now() - fs.statSync(ledger).mtimeMs < FOREIGN_RUN_MS
        // This machine under another name: macOS takes one from the network.
        || (entry.owner.startToken !== undefined && processIsLive(entry.owner));
  }
  return { files, over: ended || !live };
}

/** Remove a recorded file that is still the one recorded. False when it should be gone and is not. */
function removeRecorded(outputDir: string, file: string, stamp: FileStamp): boolean {
  const target = path.resolve(outputDir, file);
  const rel = path.relative(outputDir, target);
  if (rel === '' || rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) return true;
  try {
    const stat = fs.lstatSync(target);
    // A directory on the way there may since have become a link out of
    // outputDir; what is behind it is not this run's to remove.
    const inside = path.relative(fs.realpathSync(outputDir), fs.realpathSync(path.dirname(target)));
    if (inside.split(path.sep)[0] === '..' || path.isAbsolute(inside)) return true;
    if (stat.isFile() && stat.size === stamp.size && stat.mtimeMs === stamp.mtimeMs) fs.rmSync(target);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProcessRef(value: unknown): value is ProcessRef {
  return isRecord(value) && typeof value.pid === 'number'
    && (value.startToken === undefined || typeof value.startToken === 'string');
}

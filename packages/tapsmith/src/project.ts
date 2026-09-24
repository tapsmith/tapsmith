/**
 * Project resolution and dependency ordering.
 *
 * Mirrors Playwright's project concept: named groups of test files with
 * dependency constraints and shared `use` options.
 */

import { deviceGroupSize, effectiveConfigForProject, pinnedDeviceSerials, resolveDeviceGroup, type DeviceGroupEntry, type TapsmithConfig, type ProjectConfig, type UseOptions } from './config.js';
import { matchesTestFile } from './test-file-discovery.js';

// ─── Types ───

export interface ResolvedProject {
  name: string
  testMatch: string[]
  testIgnore: string[]
  dependencies: string[]
  use?: UseOptions
  /** Populated by the CLI after file discovery. */
  testFiles: string[]
  /** Effective config (root config merged with `use`). Populated by resolveProjects. */
  effectiveConfig: TapsmithConfig
  /**
   * Stable identifier for the device this project targets. Projects with the
   * same signature can share a worker pool; differing signatures require
   * separate device provisioning. Populated by resolveProjects.
   */
  deviceSignature: string
  /**
   * True for the project invented when a config declares none. Callers that
   * present projects to a user hide it — but they must not do that by name,
   * because a config may legitimately call one of its own projects "default".
   */
  synthesized?: boolean
  /**
   * Explicit per-project worker count. When set, this project's bucket
   * gets exactly this many devices and bypasses the proportional split.
   */
  workers?: number
  /** Per-project grep filter, intersected with the root `grep`. */
  grep?: RegExp | RegExp[]
  /** Per-project grep-invert filter, unioned with the root `grepInvert`. */
  grepInvert?: RegExp | RegExp[]
}

// ─── Device signature ───

/**
 * Build a stable signature describing the device a project targets.
 * Projects with identical signatures can share workers and devices.
 */
export function deviceSignature(config: TapsmithConfig): string {
  const platform = config.platform ?? 'android';
  const base = platform === 'ios'
    ? [
      'ios',
      config.simulator ?? '',
      config.device ?? '',
      config.package ?? '',
      config.app ?? '',
      config.iosXctestrun ?? '',
    ]
    : [
      'android',
      config.avd ?? '',
      config.device ?? '',
      config.package ?? '',
      config.apk ?? '',
      config.deviceStrategy ?? '',
      config.launchEmulators ? '1' : '0',
    ];
  // Deliberately not part of the signature: `use.devices`. A group project
  // and a single-device project on the same device shape share one target —
  // the group's primary is the single project's device — so the target is
  // provisioned once, for the largest group any of its projects declares
  // (`sharedDeviceGroup`), and a smaller project runs on the first N of it.
  return base.join('|');
}

/**
 * The group half of a target's identity — what `deviceSignature` leaves out.
 * Empty for a single-device config; names and pins otherwise
 * (`devices=alice,bob@emulator-5556`). For callers that key something per
 * *group* rather than per device target (the MCP dispatcher's daemon sets).
 */
export function deviceGroupSignature(config: Pick<TapsmithConfig, 'devices' | 'device'>): string {
  if (deviceGroupSize(config) <= 1) return '';
  return `devices=${resolveDeviceGroup(config).map((e) => `${e.name}${e.device ? `@${e.device}` : ''}`).join(',')}`;
}

/** The device group a set of projects sharing one device target run on. */
export interface SharedDeviceGroup {
  /** The effective config of the project that declares the largest group — the target's authority for provisioning. */
  config: TapsmithConfig
  /** That group, primary first. A group of one for single-device projects. */
  group: DeviceGroupEntry[]
}

const describeGroup = (group: DeviceGroupEntry[]): string =>
  group.map((e) => `${e.name}${e.device ? `@${e.device}` : ''}`).join(', ');

/**
 * Projects on one device target (same `deviceSignature`) share its devices:
 * the target is provisioned for the largest `use.devices` group among them,
 * and a project declaring a smaller group — or none — runs on the first N of
 * those devices. For that to be honest, every declared group must be a
 * prefix of the largest: the same names and the same pins, position by
 * position. Two projects that disagree are a config error, reported here by
 * name rather than surfacing as a wrong-device run.
 */
export function sharedDeviceGroup(
  projects: ReadonlyArray<Pick<ResolvedProject, 'name' | 'effectiveConfig'>>,
): SharedDeviceGroup {
  if (projects.length === 0) {
    throw new Error('sharedDeviceGroup: no projects given');
  }
  let largest = projects[0];
  for (const p of projects) {
    if (deviceGroupSize(p.effectiveConfig) > deviceGroupSize(largest.effectiveConfig)) largest = p;
  }
  const group = resolveDeviceGroup(largest.effectiveConfig);
  for (const p of projects) {
    // A group of one is a single device whatever it is called: its tests see
    // `devices[0]` only, so it has nothing to agree with the largest about.
    if (p === largest || deviceGroupSize(p.effectiveConfig) <= 1) continue;
    const own = resolveDeviceGroup(p.effectiveConfig);
    const compatible = own.every((entry, i) => {
      const shared = group[i];
      return shared !== undefined
        && shared.name === entry.name
        && (entry.device === undefined || shared.device === undefined || entry.device === shared.device);
    });
    if (!compatible) {
      throw new Error(
        `Projects "${largest.name}" and "${p.name}" target the same device but declare incompatible device groups `
        + `(${describeGroup(group)} vs ${describeGroup(own)}). Projects on one device target share its devices, so a `
        + 'smaller `use.devices` group must be the first members of the largest one — the same names and pins, in the same order.',
      );
    }
  }
  return { config: largest.effectiveConfig, group };
}

// ─── Worker allocation ───

/**
 * Allocate the global `workers` budget across project buckets.
 *
 * Rules:
 * 1. Buckets containing any project with explicit `project.workers` get
 *    `max(explicit values across the bucket's projects)`. These do not
 *    consume from the global budget — they are additive.
 * 2. Every implicit bucket with test files gets at least 1 worker,
 *    regardless of the global budget. This means the total allocation may
 *    exceed `totalBudget` when there are more implicit buckets than the
 *    budget allows — the alternative would be to silently drop entire
 *    device buckets (and their files) from the run, which is worse.
 *    Callers should treat `totalBudget` as a target, sum the returned
 *    allocation, and warn the user when the effective total exceeds it.
 * 3. Any remaining budget above `implicit.length` is distributed across
 *    implicit buckets proportionally to file count.
 * 4. Any bucket with zero test files gets 0 workers.
 * 5. When `budgetCap` is set, the total allocation is scaled down to fit
 *    within the cap. Each active bucket keeps at least 1 worker, so the
 *    effective minimum is `active.length`.
 * 6. A bucket that pins a device (root `device`, `--device`, or a
 *    `use.devices` pin) gets exactly 1 worker — a pinned device hosts one —
 *    whatever its projects' `workers` say. It consumes 1 from the budget,
 *    and the rest goes to the unpinned buckets.
 */
export function allocateBucketWorkers(
  totalBudget: number,
  bucketEntries: Array<{ signature: string; projects: ResolvedProject[] }>,
  budgetCap: number | undefined,
  /**
   * Signatures of the buckets that pin a device — {@link pinnedBucketSignatures},
   * taken *before* any device setup. Required, not derived here: the
   * sequential setup writes the device it auto-picked onto the effective
   * config, so reading pins afterwards mistakes that pick for a user's pin.
   */
  pinnedSignatures: ReadonlySet<string>,
): Map<string, number> {
  const result = new Map<string, number>();

  const active = bucketEntries.filter(
    (b) => b.projects.reduce((sum, p) => sum + p.testFiles.length, 0) > 0,
  );
  for (const inactive of bucketEntries.filter((b) => !active.includes(b))) {
    result.set(inactive.signature, 0);
  }
  if (active.length === 0) return result;

  const pinned = active.filter((b) => pinnedSignatures.has(b.signature));
  for (const b of pinned) result.set(b.signature, 1);
  const scalable = active.filter((b) => !pinned.includes(b));
  const scaleBudget = (cap: number) => scaleToBudget(result, cap - pinned.length, scalable);
  if (scalable.length === 0) return result;
  const budget = Math.max(0, totalBudget - pinned.length);

  const explicit: typeof active = [];
  const implicit: typeof active = [];
  for (const b of scalable) {
    const explicitValues = b.projects
      .map((p) => p.workers)
      .filter((w): w is number => typeof w === 'number' && w > 0);
    if (explicitValues.length > 0) {
      result.set(b.signature, Math.max(...explicitValues));
      explicit.push(b);
    } else {
      implicit.push(b);
    }
  }

  if (implicit.length === 0) {
    if (budgetCap !== undefined) scaleBudget(budgetCap);
    return result;
  }

  const implicitFiles = implicit.reduce(
    (sum, b) => sum + b.projects.reduce((s, p) => s + p.testFiles.length, 0),
    0,
  );

  for (const b of implicit) {
    result.set(b.signature, 1);
  }
  let remaining = Math.max(0, budget - implicit.length);

  if (remaining > 0 && implicitFiles > 0) {
    const ranked = implicit
      .map((b) => ({
        signature: b.signature,
        files: b.projects.reduce((s, p) => s + p.testFiles.length, 0),
      }))
      .sort((a, b) => b.files - a.files);

    while (remaining > 0) {
      let madeProgress = false;
      for (const r of ranked) {
        if (remaining === 0) break;
        const fairShare = Math.floor((budget * r.files) / implicitFiles);
        const current = result.get(r.signature) ?? 1;
        if (current < fairShare) {
          result.set(r.signature, current + 1);
          remaining--;
          madeProgress = true;
        }
      }
      if (!madeProgress) {
        // Distribute leftover workers round-robin — handles the rounding gap
        // where Math.floor(fairShare) sums to less than totalBudget.
        for (const r of ranked) {
          if (remaining === 0) break;
          result.set(r.signature, (result.get(r.signature) ?? 1) + 1);
          remaining--;
        }
        break;
      }
    }
  }

  if (budgetCap !== undefined) scaleBudget(budgetCap);
  return result;
}

/**
 * The buckets whose device target pins a device (root `device`, `--device`, a
 * `use.devices` pin), each fixed to one worker. Call it before any device
 * setup — see `allocateBucketWorkers`.
 */
export function pinnedBucketSignatures(
  bucketEntries: Array<{ signature: string; projects: ResolvedProject[] }>,
): Set<string> {
  return new Set(bucketEntries
    .filter((b) => b.projects.some((p) => pinnedDeviceSerials(p.effectiveConfig).length > 0))
    .map((b) => b.signature));
}

/**
 * Scale an allocation map so its total matches `cap`. Handles both
 * directions: scales down when over budget, scales up when under.
 * Each active bucket keeps at least 1 worker; if `cap < active.length`
 * the effective minimum is `active.length`.
 */
function scaleToBudget(
  result: Map<string, number>,
  cap: number,
  active: Array<{ signature: string; projects: ResolvedProject[] }>,
): void {
  if (active.length === 0) return;
  const total = active.reduce((s, b) => s + (result.get(b.signature) ?? 0), 0);
  if (total === cap) return;

  const effectiveCap = Math.max(cap, active.length);
  const natural = new Map(result);

  for (const b of active) {
    result.set(b.signature, 1);
  }
  let remaining = effectiveCap - active.length;
  if (remaining <= 0) return;

  const ranked = active
    .map((b) => ({
      signature: b.signature,
      natural: natural.get(b.signature) ?? 0,
    }))
    .sort((a, b) => b.natural - a.natural);

  for (const r of ranked) {
    if (remaining === 0) break;
    const targetShare = Math.floor((effectiveCap * r.natural) / total);
    const toAdd = Math.min(remaining, Math.max(0, targetShare - 1));
    if (toAdd > 0) {
      result.set(r.signature, 1 + toAdd);
      remaining -= toAdd;
    }
  }

  if (remaining > 0) {
    for (const r of ranked) {
      if (remaining === 0) break;
      result.set(r.signature, (result.get(r.signature) ?? 1) + 1);
      remaining--;
    }
  }
}

/**
 * Group resolved projects by their device signature, preserving first-seen
 * order. Each entry contains the signature and the projects sharing it.
 */
export function bucketizeProjects(
  projects: ResolvedProject[],
): Array<{ signature: string; projects: ResolvedProject[] }> {
  const m = new Map<string, ResolvedProject[]>();
  for (const p of projects) {
    const arr = m.get(p.deviceSignature) ?? [];
    arr.push(p);
    m.set(p.deviceSignature, arr);
  }
  return [...m.entries()].map(([signature, projects]) => ({ signature, projects }));
}

// ─── Per-project use validation ───

function validateProjectUse(name: string, use: UseOptions | undefined): void {
  if (!use) return;

  const platform = use.platform;
  if (platform === 'ios') {
    if (use.avd != null) {
      throw new Error(`Project "${name}" sets platform: 'ios' but also \`avd\` (Android-only). Remove \`avd\` or change platform.`);
    }
    if (use.apk != null) {
      throw new Error(`Project "${name}" sets platform: 'ios' but also \`apk\` (Android-only). Use \`app\` for iOS.`);
    }
    if (use.agentApk != null || use.agentTestApk != null) {
      throw new Error(`Project "${name}" sets platform: 'ios' but also \`agentApk\`/\`agentTestApk\` (Android-only).`);
    }
  } else if (platform === 'android') {
    if (use.simulator != null) {
      throw new Error(`Project "${name}" sets platform: 'android' but also \`simulator\` (iOS-only). Remove \`simulator\` or change platform.`);
    }
    if (use.app != null) {
      throw new Error(`Project "${name}" sets platform: 'android' but also \`app\` (iOS-only). Use \`apk\` for Android.`);
    }
    if (use.iosXctestrun != null) {
      throw new Error(`Project "${name}" sets platform: 'android' but also \`iosXctestrun\` (iOS-only).`);
    }
  } else {
    // Platform unset — fall back to detecting via mutually-exclusive fields
    if ((use.avd != null || use.apk != null) && (use.simulator != null || use.app != null || use.iosXctestrun != null)) {
      throw new Error(`Project "${name}" mixes Android (\`avd\`/\`apk\`) and iOS (\`simulator\`/\`app\`) fields. Set \`platform\` and use only one set.`);
    }
  }
}

/**
 * The name to attribute a project's results to, or `undefined` when the
 * project is one Tapsmith invented rather than one the user declared.
 *
 * The single place that decision is made. Every consumer used to test the name
 * against "default", which silently dropped attribution for a project a config
 * genuinely named that — and any half-migration is worse than either
 * consistent state, because the side that lists projects and the side that
 * records their results then disagree and joins come up empty.
 */
export function projectLabel(project: Pick<ResolvedProject, 'name' | 'synthesized'> | undefined): string | undefined {
  return project && !project.synthesized ? project.name : undefined;
}

// ─── Resolution ───

/**
 * Resolve the project configuration. When `config.projects` is defined,
 * validates names, dependencies, and cycles. When not defined, returns a
 * single synthetic "default" project so the rest of the pipeline always
 * works with the project abstraction.
 */
export function resolveProjects(config: TapsmithConfig): ResolvedProject[] {
  if (!config.projects || config.projects.length === 0) {
    return [{
      name: 'default',
      synthesized: true,
      testMatch: config.testMatch,
      testIgnore: [],
      dependencies: [],
      use: undefined,
      testFiles: [],
      effectiveConfig: config,
      deviceSignature: deviceSignature(config),
    }];
  }

  const projects = config.projects;
  const names = new Set<string>();

  // Validate unique names
  for (const p of projects) {
    if (!p.name) {
      throw new Error('Every project must have a name');
    }
    if (names.has(p.name)) {
      throw new Error(`Duplicate project name: "${p.name}"`);
    }
    names.add(p.name);
  }

  // Validate dependency references
  for (const p of projects) {
    for (const dep of p.dependencies ?? []) {
      if (!names.has(dep)) {
        throw new Error(
          `Project "${p.name}" depends on "${dep}", which does not exist. ` +
          `Available projects: ${[...names].join(', ')}`,
        );
      }
      if (dep === p.name) {
        throw new Error(`Project "${p.name}" cannot depend on itself`);
      }
    }
  }

  // Validate no cycles
  detectCycles(projects);

  // Validate per-project device-shaping fields
  for (const p of projects) {
    validateProjectUse(p.name, p.use);
  }

  return projects.map((p) => {
    const effective = effectiveConfigForProject(config, p);
    return {
      name: p.name,
      testMatch: p.testMatch ?? config.testMatch,
      testIgnore: p.testIgnore ?? [],
      dependencies: p.dependencies ?? [],
      use: p.use,
      testFiles: [],
      effectiveConfig: effective,
      deviceSignature: deviceSignature(effective),
      workers: p.workers,
      grep: p.grep,
      grepInvert: p.grepInvert,
    };
  });
}

// ─── Topological sort ───

/**
 * Sort projects into execution waves using Kahn's algorithm.
 * Returns an array of waves — each wave is a list of projects whose
 * dependencies are satisfied by all preceding waves.
 *
 * Wave 0 = no dependencies, wave 1 = depends only on wave 0, etc.
 */
export function topologicalSort(projects: ResolvedProject[]): ResolvedProject[][] {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const inDegree = new Map(projects.map((p) => [p.name, 0]));

  for (const p of projects) {
    for (const _dep of p.dependencies) {
      inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1);
    }
  }

  const waves: ResolvedProject[][] = [];
  const remaining = new Set(projects.map((p) => p.name));

  while (remaining.size > 0) {
    const wave: ResolvedProject[] = [];

    for (const name of remaining) {
      if ((inDegree.get(name) ?? 0) === 0) {
        wave.push(byName.get(name)!);
      }
    }

    if (wave.length === 0) {
      // Should not happen if detectCycles passed, but guard anyway
      throw new Error(
        `Circular dependency detected among projects: ${[...remaining].join(', ')}`,
      );
    }

    for (const p of wave) {
      remaining.delete(p.name);

      // Decrease in-degree for dependents
      for (const other of projects) {
        if (other.dependencies.includes(p.name)) {
          inDegree.set(other.name, (inDegree.get(other.name) ?? 0) - 1);
        }
      }
    }

    waves.push(wave);
  }

  return waves;
}

// ─── Dependency collection ───

/**
 * Given a set of project names, collect all their transitive dependencies.
 * Returns the full set of project names that need to run (including the input names).
 */
export function collectTransitiveDeps(
  projectNames: Set<string>,
  allProjects: ResolvedProject[],
): Set<string> {
  const byName = new Map(allProjects.map((p) => [p.name, p]));
  const result = new Set<string>();

  function collect(name: string): void {
    if (result.has(name)) return;
    result.add(name);
    const project = byName.get(name);
    if (project) {
      for (const dep of project.dependencies) {
        collect(dep);
      }
    }
  }

  for (const name of projectNames) {
    collect(name);
  }

  return result;
}

/**
 * Validate that every requested `--project` name matches a configured project.
 * Throws with the list of available names if any name is unknown.
 */
export function validateProjectNames(
  requested: string[],
  allProjects: ResolvedProject[],
): void {
  const available = new Set(allProjects.map((p) => p.name));
  for (const name of requested) {
    if (!available.has(name)) {
      throw new Error(
        `Project "${name}" not found. Available projects: ${[...available].join(', ')}`,
      );
    }
  }
}

/**
 * Find ALL projects a file belongs to by matching against testMatch/testIgnore
 * patterns. A file can match multiple projects (e.g. the same test running on
 * both Android and iOS).
 */
export function findProjectsForFile(
  filePath: string,
  projects: ResolvedProject[],
  rootDir: string,
): string[] {
  const matches: string[] = [];
  for (const project of projects) {
    if (matchesTestFile(filePath, project.testMatch, rootDir, project.testIgnore)) {
      matches.push(project.name);
    }
  }
  return matches;
}

// ─── Cycle detection ───

function detectCycles(projects: ProjectConfig[]): void {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const depMap = new Map(projects.map((p) => [p.name, p.dependencies ?? []]));

  function dfs(name: string, path: string[]): void {
    if (stack.has(name)) {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name].join(' → ');
      throw new Error(`Circular dependency detected: ${cycle}`);
    }
    if (visited.has(name)) return;

    stack.add(name);
    path.push(name);

    for (const dep of depMap.get(name) ?? []) {
      dfs(dep, path);
    }

    stack.delete(name);
    path.pop();
    visited.add(name);
  }

  for (const p of projects) {
    dfs(p.name, []);
  }
}

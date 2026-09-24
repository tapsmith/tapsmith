import { describe, it, expect } from 'vitest';
import { resolveProjects, topologicalSort, collectTransitiveDeps, findProjectsForFile, validateProjectNames, deviceSignature, allocateBucketWorkers as allocateWithPins, bucketizeProjects, pinnedBucketSignatures, workerPlanNote, devicePinWorkersConflict, platformOfSerial, scopeDevicePinToPlatform, devicesPinnedByManyBuckets, type ResolvedProject } from '../project.js';
import { effectiveConfigForProject, type TapsmithConfig } from '../config.js';

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'only-on-failure',
    testMatch: ['**/*.test.ts'],
    daemonAddress: 'localhost:50051',
    rootDir: '/tmp',
    outputDir: 'tapsmith-results',
    workers: 1,
    launchEmulators: false,
    ...overrides,
  };
}

// ─── resolveProjects ───

describe('resolveProjects()', () => {
  it('returns single default project when no projects configured', () => {
    const projects = resolveProjects(makeConfig());
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('default');
    expect(projects[0].testMatch).toEqual(['**/*.test.ts']);
    expect(projects[0].dependencies).toEqual([]);
  });

  it('returns single default project when projects is empty array', () => {
    const projects = resolveProjects(makeConfig({ projects: [] }));
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('default');
  });

  it('resolves projects with inherited testMatch', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'a' },
        { name: 'b', testMatch: ['**/special.ts'] },
      ],
    }));
    expect(projects[0].testMatch).toEqual(['**/*.test.ts']);
    expect(projects[1].testMatch).toEqual(['**/special.ts']);
  });

  it('preserves use options', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'auth', use: { appState: './state.tar.gz', timeout: 5000 } },
      ],
    }));
    expect(projects[0].use).toEqual({ appState: './state.tar.gz', timeout: 5000 });
  });

  it('rejects duplicate project names', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'foo' },
        { name: 'foo' },
      ],
    }))).toThrow('Duplicate project name: "foo"');
  });

  it('rejects empty project name', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [{ name: '' }],
    }))).toThrow('Every project must have a name');
  });

  it('rejects missing dependency reference', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['nonexistent'] },
      ],
    }))).toThrow('does not exist');
  });

  it('rejects self-dependency', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['a'] },
      ],
    }))).toThrow('cannot depend on itself');
  });

  it('rejects circular dependencies', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['b'] },
        { name: 'b', dependencies: ['a'] },
      ],
    }))).toThrow('Circular dependency');
  });

  it('rejects transitive circular dependencies', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'a', dependencies: ['c'] },
        { name: 'b', dependencies: ['a'] },
        { name: 'c', dependencies: ['b'] },
      ],
    }))).toThrow('Circular dependency');
  });
});

// ─── topologicalSort ───

describe('topologicalSort()', () => {
  it('returns single wave for projects with no dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'a' },
        { name: 'b' },
      ],
    }));
    const waves = topologicalSort(projects);
    expect(waves).toHaveLength(1);
    expect(waves[0].map((p) => p.name).sort()).toEqual(['a', 'b']);
  });

  it('returns correct wave order for linear chain', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'auth', dependencies: ['setup'] },
        { name: 'e2e', dependencies: ['auth'] },
      ],
    }));
    const waves = topologicalSort(projects);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((p) => p.name)).toEqual(['setup']);
    expect(waves[1].map((p) => p.name)).toEqual(['auth']);
    expect(waves[2].map((p) => p.name)).toEqual(['e2e']);
  });

  it('resolves diamond dependency correctly', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'a', dependencies: ['setup'] },
        { name: 'b', dependencies: ['setup'] },
        { name: 'final', dependencies: ['a', 'b'] },
      ],
    }));
    const waves = topologicalSort(projects);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((p) => p.name)).toEqual(['setup']);
    expect(waves[1].map((p) => p.name).sort()).toEqual(['a', 'b']);
    expect(waves[2].map((p) => p.name)).toEqual(['final']);
  });

  it('places independent roots in wave 0', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'independent' },
        { name: 'dependent', dependencies: ['setup'] },
      ],
    }));
    const waves = topologicalSort(projects);
    expect(waves).toHaveLength(2);
    expect(waves[0].map((p) => p.name).sort()).toEqual(['independent', 'setup']);
    expect(waves[1].map((p) => p.name)).toEqual(['dependent']);
  });

  it('handles single default project', () => {
    const projects = resolveProjects(makeConfig());
    const waves = topologicalSort(projects);
    expect(waves).toHaveLength(1);
    expect(waves[0][0].name).toBe('default');
  });
});

// ─── collectTransitiveDeps ───

describe('collectTransitiveDeps()', () => {
  it('returns just the project when it has no dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [{ name: 'a' }, { name: 'b' }],
    }));
    const result = collectTransitiveDeps(new Set(['a']), projects);
    expect([...result]).toEqual(['a']);
  });

  it('includes direct dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'auth', dependencies: ['setup'] },
      ],
    }));
    const result = collectTransitiveDeps(new Set(['auth']), projects);
    expect([...result].sort()).toEqual(['auth', 'setup']);
  });

  it('includes transitive dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'a' },
        { name: 'b', dependencies: ['a'] },
        { name: 'c', dependencies: ['b'] },
      ],
    }));
    const result = collectTransitiveDeps(new Set(['c']), projects);
    expect([...result].sort()).toEqual(['a', 'b', 'c']);
  });

  it('deduplicates diamond dependencies', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup' },
        { name: 'a', dependencies: ['setup'] },
        { name: 'b', dependencies: ['setup'] },
        { name: 'final', dependencies: ['a', 'b'] },
      ],
    }));
    const result = collectTransitiveDeps(new Set(['final']), projects);
    expect([...result].sort()).toEqual(['a', 'b', 'final', 'setup']);
  });
});

// ─── validateProjectNames ───

describe('validateProjectNames()', () => {
  it('accepts names that exist', () => {
    const projects = resolveProjects(makeConfig({
      projects: [{ name: 'android' }, { name: 'ios' }],
    }));
    expect(() => validateProjectNames(['android'], projects)).not.toThrow();
    expect(() => validateProjectNames(['android', 'ios'], projects)).not.toThrow();
  });

  it('throws listing available projects when a name is unknown', () => {
    const projects = resolveProjects(makeConfig({
      projects: [{ name: 'android' }, { name: 'ios' }],
    }));
    expect(() => validateProjectNames(['web'], projects)).toThrow(
      /Project "web" not found\. Available projects: android, ios/,
    );
  });

  it('reports the first unknown name when several are given', () => {
    const projects = resolveProjects(makeConfig({
      projects: [{ name: 'android' }],
    }));
    expect(() => validateProjectNames(['android', 'nope'], projects)).toThrow(
      /Project "nope" not found/,
    );
  });
});

// ─── findProjectsForFile ───

describe('findProjectsForFile()', () => {
  it('matches file to project by testMatch', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup', testMatch: ['**/auth.setup.ts'] },
        { name: 'default', testMatch: ['**/*.test.ts'] },
      ],
    }));
    expect(findProjectsForFile('/tmp/tests/auth.setup.ts', projects, '/tmp')).toEqual(['setup']);
    expect(findProjectsForFile('/tmp/tests/foo.test.ts', projects, '/tmp')).toEqual(['default']);
  });

  it('respects testIgnore', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'default', testMatch: ['**/*.test.ts'], testIgnore: ['**/app-state.test.ts'] },
        { name: 'auth', testMatch: ['**/app-state.test.ts'] },
      ],
    }));
    expect(findProjectsForFile('/tmp/tests/app-state.test.ts', projects, '/tmp')).toEqual(['auth']);
  });

  it('returns empty array for unmatched file', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'setup', testMatch: ['**/auth.setup.ts'] },
      ],
    }));
    expect(findProjectsForFile('/tmp/tests/foo.test.ts', projects, '/tmp')).toEqual([]);
  });

  it('returns all matching projects when file matches multiple', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'android', testMatch: ['**/*.test.ts'] },
        { name: 'ios', testMatch: ['**/*.test.ts'] },
      ],
    }));
    expect(findProjectsForFile('/tmp/tests/foo.test.ts', projects, '/tmp')).toEqual(['android', 'ios']);
  });

  it('returns all matching projects respecting testIgnore per project', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'android', testMatch: ['**/*.test.ts'] },
        { name: 'ios', testMatch: ['**/*.test.ts'], testIgnore: ['**/*.android.test.ts'] },
      ],
    }));
    expect(findProjectsForFile('/tmp/tests/foo.test.ts', projects, '/tmp')).toEqual(['android', 'ios']);
    expect(findProjectsForFile('/tmp/tests/bar.android.test.ts', projects, '/tmp')).toEqual(['android']);
  });

  it('does not treat a sibling directory sharing the rootDir prefix as inside rootDir', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'default', testMatch: ['tests/*.test.ts'] },
      ],
    }));
    // /tmp-other is NOT inside /tmp — must not be relativized to '-other/tests/...'
    expect(findProjectsForFile('/tmp-other/tests/foo.test.ts', projects, '/tmp')).toEqual([]);
    expect(findProjectsForFile('/tmp/tests/foo.test.ts', projects, '/tmp')).toEqual(['default']);
  });

  it('handles rootDir with a trailing slash', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'default', testMatch: ['tests/*.test.ts'] },
      ],
    }));
    expect(findProjectsForFile('/tmp/tests/foo.test.ts', projects, '/tmp/')).toEqual(['default']);
  });
});

// ─── effectiveConfigForProject ───

describe('effectiveConfigForProject()', () => {
  it('returns the root config when project has no use options', () => {
    const root = makeConfig({ apk: './app.apk' });
    const merged = effectiveConfigForProject(root, { use: undefined });
    expect(merged).toBe(root);
  });

  it('overrides scalar fields from use', () => {
    const root = makeConfig({ apk: './root.apk', timeout: 5000 });
    const merged = effectiveConfigForProject(root, { use: { timeout: 9000 } });
    expect(merged.timeout).toBe(9000);
    expect(merged.apk).toBe('./root.apk');
  });

  it('overrides device-shaping fields from use', () => {
    const root = makeConfig({ platform: 'android', avd: 'Pixel_6', apk: './a.apk' });
    const merged = effectiveConfigForProject(root, {
      use: { platform: 'ios', simulator: 'iPhone 16', app: './a.app' },
    });
    expect(merged.platform).toBe('ios');
    expect(merged.simulator).toBe('iPhone 16');
    expect(merged.app).toBe('./a.app');
    // Root fields are still present (we leave them; deviceSignature ignores irrelevant ones)
    expect(merged.avd).toBe('Pixel_6');
  });

  it('skips undefined values in use', () => {
    const root = makeConfig({ timeout: 5000 });
    const merged = effectiveConfigForProject(root, { use: { timeout: undefined } });
    expect(merged.timeout).toBe(5000);
  });
});

// ─── deviceSignature ───

describe('deviceSignature()', () => {
  it('produces a stable string for android configs', () => {
    const sig = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_6', package: 'com.x', apk: './a.apk' }));
    expect(sig.startsWith('android|')).toBe(true);
    expect(sig).toContain('Pixel_6');
    expect(sig).toContain('com.x');
  });

  it('produces a different signature for ios vs android', () => {
    const a = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_6' }));
    const i = deviceSignature(makeConfig({ platform: 'ios', simulator: 'iPhone 16' }));
    expect(a).not.toBe(i);
  });

  it('two android configs targeting different AVDs differ', () => {
    const a = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_6' }));
    const b = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_7' }));
    expect(a).not.toBe(b);
  });

  it('identical android configs match', () => {
    const a = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_6', apk: './x.apk', package: 'com.x' }));
    const b = deviceSignature(makeConfig({ platform: 'android', avd: 'Pixel_6', apk: './x.apk', package: 'com.x' }));
    expect(a).toBe(b);
  });
});

// ─── per-project use validation ───

describe('resolveProjects() — device validation', () => {
  it('rejects mixing avd + simulator in a single project use', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'mixed', use: { avd: 'Pixel_6', simulator: 'iPhone 16' } },
      ],
    }))).toThrow(/mixes Android.*and iOS/i);
  });

  it('rejects platform: ios with avd', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'bad', use: { platform: 'ios', avd: 'Pixel_6' } },
      ],
    }))).toThrow(/avd.*Android-only/i);
  });

  it('rejects platform: android with simulator', () => {
    expect(() => resolveProjects(makeConfig({
      projects: [
        { name: 'bad', use: { platform: 'android', simulator: 'iPhone 16' } },
      ],
    }))).toThrow(/simulator.*iOS-only/i);
  });

  it('populates effectiveConfig and deviceSignature on each resolved project', () => {
    const projects = resolveProjects(makeConfig({
      platform: 'android',
      avd: 'Pixel_6',
      projects: [
        { name: 'a' },
        { name: 'b', use: { platform: 'ios', simulator: 'iPhone 16' } },
      ],
    }));
    expect(projects[0].effectiveConfig.platform).toBe('android');
    expect(projects[0].effectiveConfig.avd).toBe('Pixel_6');
    expect(projects[1].effectiveConfig.platform).toBe('ios');
    expect(projects[1].effectiveConfig.simulator).toBe('iPhone 16');
    expect(projects[0].deviceSignature).not.toBe(projects[1].deviceSignature);
  });

  it('carries through explicit per-project workers', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'android', workers: 3, use: { platform: 'android', avd: 'P' } },
        { name: 'ios', workers: 2, use: { platform: 'ios', simulator: 'I' } },
        { name: 'unset' },
      ],
    }));
    expect(projects[0].workers).toBe(3);
    expect(projects[1].workers).toBe(2);
    expect(projects[2].workers).toBeUndefined();
  });
});

// ─── allocateBucketWorkers ───

describe('allocateBucketWorkers()', () => {
  // Pins read live from the projects — what every caller passes when it
  // allocates before device setup.
  const allocateBucketWorkers = (budget: number, buckets: ReturnType<typeof bucketizeProjects>, cap?: number) =>
    allocateWithPins(budget, buckets, cap, pinnedBucketSignatures(buckets));

  function makeProject(
    name: string,
    fileCount: number,
    workers?: number,
  ): ResolvedProject {
    const cfg = makeConfig();
    return {
      name,
      testMatch: [],
      testIgnore: [],
      dependencies: [],
      testFiles: Array.from({ length: fileCount }, (_, i) => `f${i}.ts`),
      effectiveConfig: cfg,
      deviceSignature: name,  // unique sig per project for these tests
      workers,
    };
  }

  it('splits the global budget proportionally to file count', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 8),
      makeProject('b', 2),
    ]);
    const alloc = allocateBucketWorkers(5, buckets);
    expect(alloc.get('a')).toBe(4);
    expect(alloc.get('b')).toBe(1);
  });

  it('gives each active bucket at least 1 worker', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 100),
      makeProject('b', 1),
    ]);
    const alloc = allocateBucketWorkers(2, buckets);
    expect(alloc.get('a')).toBe(1);
    expect(alloc.get('b')).toBe(1);
  });

  it('skips buckets with zero test files', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 5),
      makeProject('b', 0),
    ]);
    const alloc = allocateBucketWorkers(4, buckets);
    expect(alloc.get('a')).toBeGreaterThan(0);
    expect(alloc.get('b')).toBe(0);
  });

  it('honors explicit per-project workers (additive, not consuming budget)', () => {
    const buckets = bucketizeProjects([
      makeProject('explicit', 4, 3),
      makeProject('implicit', 4),
    ]);
    const alloc = allocateBucketWorkers(2, buckets);
    expect(alloc.get('explicit')).toBe(3);
    // Implicit bucket gets the full budget of 2 (not reduced by explicit)
    expect(alloc.get('implicit')).toBe(2);
  });

  it('uses max() across multiple explicit projects in the same bucket', () => {
    // Two projects sharing the same signature with different workers
    const sharedSig = 'shared';
    const buckets = [
      {
        signature: sharedSig,
        projects: [
          { ...makeProject('p1', 3, 2), deviceSignature: sharedSig },
          { ...makeProject('p2', 3, 5), deviceSignature: sharedSig },
        ],
      },
    ];
    const alloc = allocateBucketWorkers(1, buckets);
    expect(alloc.get(sharedSig)).toBe(5);
  });

  it('falls back to 1 per implicit bucket when global budget is too small', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 10),
      makeProject('b', 10),
      makeProject('c', 10),
    ]);
    const alloc = allocateBucketWorkers(1, buckets);
    expect(alloc.get('a')).toBe(1);
    expect(alloc.get('b')).toBe(1);
    expect(alloc.get('c')).toBe(1);
  });

  it('distributes remainder when fairShare rounding leaves workers unallocated', () => {
    // 3 equal buckets, budget=5: fairShare = floor(5*1/3) = 1 per bucket.
    // Each starts at 1 (minimum), so proportional loop makes no progress.
    // The 2 remaining workers should be distributed round-robin.
    const buckets = bucketizeProjects([
      makeProject('a', 10),
      makeProject('b', 10),
      makeProject('c', 10),
    ]);
    const alloc = allocateBucketWorkers(5, buckets);
    const total = (alloc.get('a') ?? 0) + (alloc.get('b') ?? 0) + (alloc.get('c') ?? 0);
    expect(total).toBe(5);
    // Each bucket gets at least 1, and the 2 extras go to the first two
    expect(alloc.get('a')).toBe(2);
    expect(alloc.get('b')).toBe(2);
    expect(alloc.get('c')).toBe(1);
  });

  it('works with all-explicit allocation (no implicit consumption)', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 5, 2),
      makeProject('b', 5, 1),
    ]);
    const alloc = allocateBucketWorkers(0, buckets);
    expect(alloc.get('a')).toBe(2);
    expect(alloc.get('b')).toBe(1);
  });

  // ─── budgetCap ───

  it('budgetCap scales down explicit workers to fit within cap', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 5, 2),
      makeProject('b', 5, 2),
    ]);
    const alloc = allocateBucketWorkers(4, buckets, 2);
    expect(alloc.get('a')).toBe(1);
    expect(alloc.get('b')).toBe(1);
  });

  it('budgetCap distributes proportionally when scaling down', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 5, 4),
      makeProject('b', 5, 2),
    ]);
    const alloc = allocateBucketWorkers(6, buckets, 3);
    expect(alloc.get('a')).toBe(2);
    expect(alloc.get('b')).toBe(1);
  });

  it('budgetCap scales up explicit workers when cap exceeds natural total', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 5, 2),
      makeProject('b', 5, 2),
    ]);
    // Natural allocation: a=2, b=2, total=4.  Cap=6 → scale up to 6.
    const alloc = allocateBucketWorkers(4, buckets, 6);
    expect(alloc.get('a')).toBe(3);
    expect(alloc.get('b')).toBe(3);
  });

  it('budgetCap is a no-op when total already matches cap', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 5, 2),
      makeProject('b', 5, 1),
    ]);
    const alloc = allocateBucketWorkers(3, buckets, 3);
    expect(alloc.get('a')).toBe(2);
    expect(alloc.get('b')).toBe(1);
  });

  it('budgetCap with fewer workers than buckets keeps 1 per bucket', () => {
    const buckets = bucketizeProjects([
      makeProject('a', 5, 3),
      makeProject('b', 5, 3),
      makeProject('c', 5, 3),
    ]);
    const alloc = allocateBucketWorkers(9, buckets, 2);
    expect(alloc.get('a')).toBe(1);
    expect(alloc.get('b')).toBe(1);
    expect(alloc.get('c')).toBe(1);
    const total = (alloc.get('a') ?? 0) + (alloc.get('b') ?? 0) + (alloc.get('c') ?? 0);
    expect(total).toBe(3);
  });

  // A pinned device (root `device`, `--device`, or a `use.devices` pin) can
  // host exactly one worker. Every path used to hand such a bucket its full
  // share and then either ignore the pin (Android parallel, watch) or pile
  // extra workers onto other devices beside it (PILOT-261, PILOT-313).
  describe('pinned device targets', () => {
    function pinnedProject(name: string, fileCount: number, pin: Partial<TapsmithConfig>, workers?: number): ResolvedProject {
      return { ...makeProject(name, fileCount, workers), effectiveConfig: makeConfig(pin) };
    }

    it('gives a bucket pinned by root `device` one worker whatever the budget', () => {
      const buckets = bucketizeProjects([pinnedProject('a', 8, { device: 'emulator-5554' })]);
      expect(allocateBucketWorkers(4, buckets).get('a')).toBe(1);
    });

    it('gives a bucket pinned by a group member one worker', () => {
      const buckets = bucketizeProjects([pinnedProject('a', 8, { devices: [{ name: 'alice' }, { name: 'bob', device: 'X' }] })]);
      expect(allocateBucketWorkers(4, buckets).get('a')).toBe(1);
    });

    it('caps an explicit per-project `workers` on a pinned bucket at one', () => {
      const buckets = bucketizeProjects([pinnedProject('a', 8, { device: 'emulator-5554' }, 3)]);
      expect(allocateBucketWorkers(1, buckets).get('a')).toBe(1);
    });

    it('hands the budget a pinned bucket cannot use to the unpinned ones', () => {
      const buckets = bucketizeProjects([
        pinnedProject('pinned', 8, { device: 'emulator-5554' }),
        makeProject('free', 2),
      ]);
      const alloc = allocateBucketWorkers(4, buckets);
      expect(alloc.get('pinned')).toBe(1);
      expect(alloc.get('free')).toBe(3);
    });

    it('never scales a pinned bucket above one to meet budgetCap', () => {
      const buckets = bucketizeProjects([
        pinnedProject('pinned', 8, { device: 'emulator-5554' }),
        makeProject('free', 2, 1),
      ]);
      const alloc = allocateBucketWorkers(1, buckets, 4);
      expect(alloc.get('pinned')).toBe(1);
      expect(alloc.get('free')).toBe(3);
    });

    it('takes the pins it is handed, not whatever the configs say by now', () => {
      // The sequential setup writes its auto-picked serial onto the effective
      // config; an allocation made after that must not read it as a pin.
      const buckets = bucketizeProjects([pinnedProject('a', 8, { device: 'emulator-5554' })]);
      expect(allocateWithPins(4, buckets, undefined, new Set()).get('a')).toBe(4);
    });

    it('counts only the pins the shared group is provisioned on', () => {
      // A smaller compatible group may pin a member the largest leaves free;
      // provisioning follows the largest group, so capping the bucket for
      // that pin cost parallelism and named a device no worker used.
      const trio = { ...makeProject('trio', 4), deviceSignature: 'shared', effectiveConfig: makeConfig({ devices: [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }] }) };
      const pair = { ...makeProject('pair', 4), deviceSignature: 'shared', effectiveConfig: makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5558' }] }) };
      expect([...pinnedBucketSignatures(bucketizeProjects([trio, pair])).keys()]).toEqual([]);
      // A pin on the largest group does count.
      const pinnedTrio = { ...trio, effectiveConfig: makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5558' }, { name: 'carol' }] }) };
      expect([...pinnedBucketSignatures(bucketizeProjects([pinnedTrio, pair])).keys()]).toEqual(['shared']);
    });

    // The sequential setup later writes its auto-picked serial onto the root
    // config that `use`-less projects share; the snapshot must keep the pins
    // as they were, or a bucket reads another platform's auto-pick as its pin.
    it('snapshots the pinned serials, not just which buckets are pinned', () => {
      const project = pinnedProject('a', 8, { device: 'emulator-5554' });
      const snapshot = pinnedBucketSignatures(bucketizeProjects([project]));
      project.effectiveConfig.device = 'SIM-UDID';
      expect(snapshot.get('a')?.pins).toEqual(['emulator-5554']);
      // The group too: provisioning builds the bucket's devices from it.
      expect(snapshot.get('a')?.group).toEqual([{ name: 'device-1', device: 'emulator-5554' }]);
    });

    it('still gives a pinned bucket with no files zero workers', () => {
      const buckets = bucketizeProjects([pinnedProject('a', 0, { device: 'emulator-5554' })]);
      expect(allocateBucketWorkers(4, buckets).get('a')).toBe(0);
    });
  });

  it('budgetCap scales down mixed explicit and implicit allocation', () => {
    const buckets = bucketizeProjects([
      makeProject('explicit', 4, 3),
      makeProject('implicit', 4),
    ]);
    // Without cap: explicit=3, implicit=2, total=5
    // With cap=3: scale to 3
    const alloc = allocateBucketWorkers(2, buckets, 3);
    expect(alloc.get('explicit')).toBe(2);
    expect(alloc.get('implicit')).toBe(1);
  });
});

// ─── Worker plan messages ───

describe('devicePinWorkersConflict()', () => {
  it('refuses --device with --workers above one, naming both', () => {
    expect(devicePinWorkersConflict('emulator-5554', 3, 1)).toMatch(/--device emulator-5554 pins the run to one device, so it cannot run --workers 3/);
  });

  // Scoped to one platform in a mixed config, --device leaves the other
  // platform's bucket free to use the workers — as it could on main.
  it('allows --workers the run can still use beside the pin', () => {
    expect(devicePinWorkersConflict('emulator-5554', 2, 2)).toBeUndefined();
    expect(devicePinWorkersConflict('emulator-5554', 3, 2)).toMatch(/cannot run --workers 3/);
  });

  // Fewer files than workers already leaves the extra workers idle; the pin
  // takes nothing away there, and main ran the pair sequentially on the pin.
  it('allows --workers the run could not have used anyway', () => {
    expect(devicePinWorkersConflict('emulator-5554', 2, 1, 1)).toBeUndefined();
    expect(devicePinWorkersConflict('emulator-5554', 3, 1, 2)).toMatch(/cannot run --workers 3/);
  });

  it('allows either alone, or --workers 1', () => {
    expect(devicePinWorkersConflict('emulator-5554', undefined, 1)).toBeUndefined();
    expect(devicePinWorkersConflict('emulator-5554', 1, 1)).toBeUndefined();
    expect(devicePinWorkersConflict(undefined, 4, 4)).toBeUndefined();
  });
});

describe('workerPlanNote()', () => {
  it('says the config asked, when the count came from the config', () => {
    expect(workerPlanNote({ requested: 2, explicit: true, fromCli: false, running: 1, activeBuckets: 1, pins: ['emulator-5554'] }))
      .toBe('config asks for 2 workers; running 1 because emulator-5554 is a pinned device (a pinned device hosts one worker)');
  });

  it('says the user asked, when --workers set the count', () => {
    expect(workerPlanNote({ requested: 3, explicit: true, fromCli: true, running: 1, activeBuckets: 1, pins: ['emulator-5554'] }))
      .toBe('requested 3 workers; running 1 because emulator-5554 is a pinned device (a pinned device hosts one worker)');
  });

  // A config file's `workers` also counts as explicit (it is what the user
  // asked for), but it was not asked on the command line: the note used to
  // say "requested 2 workers" for a `workers: 2` in the config.
  it('says the config asked when an explicit count came from the config file', () => {
    expect(workerPlanNote({ requested: 1, explicit: true, fromCli: false, running: 2, activeBuckets: 2, pins: [] }))
      .toBe('config asks for 1 worker; running 2 because 2 device targets need one each');
  });

  it('explains running more than requested by the device targets', () => {
    expect(workerPlanNote({ requested: 1, explicit: true, fromCli: true, running: 2, activeBuckets: 2, pins: [] }))
      .toBe('requested 1 worker; running 2 because 2 device targets need one each');
  });

  it('is silent when the plan matches, or nothing pinned explains a shortfall', () => {
    expect(workerPlanNote({ requested: 2, explicit: false, fromCli: false, running: 2, activeBuckets: 1, pins: [] })).toBeUndefined();
    expect(workerPlanNote({ requested: 4, explicit: false, fromCli: false, running: 2, activeBuckets: 1, pins: [] })).toBeUndefined();
  });
});

// `--device` lands on the root config, so every project inherits it — the
// iOS project of an android+ios config too, whose bucket then became "fully
// pinned" to an Android serial and failed where it used to run on simulators.
describe('--device platform scoping', () => {
  it('tells an adb-connected serial from a simulator or device UDID', () => {
    expect(platformOfSerial('emulator-5554')).toBe('android');
    expect(platformOfSerial('R5CR10XXXXX')).toBe('android');
    expect(platformOfSerial('4324E8D7-E006-4766-94FF-F6FD9655320F')).toBe('ios');
    expect(platformOfSerial('00008110-001A2C3E0E83801E')).toBe('ios');
    // A pre-XS iPhone's 40-hex UDID.
    expect(platformOfSerial('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe('ios');
    // An emulator serial is Android even before adb lists it (still booting, or launched later).
    expect(platformOfSerial('emulator-5560')).toBe('android');
    // iOS identifiers are always UDID-shaped, so anything else is Android —
    // a physical phone that is unplugged right now included.
    expect(platformOfSerial('R5CR10XXXXX')).toBe('android');
    expect(platformOfSerial('192.168.1.5:5555')).toBe('android');
  });

  function project(name: string, platform: 'android' | 'ios', device?: string): ResolvedProject {
    const effectiveConfig = makeConfig({ platform, device });
    return {
      name, testMatch: [], testIgnore: [], dependencies: [], testFiles: ['a.test.ts'],
      effectiveConfig, deviceSignature: deviceSignature(effectiveConfig),
    };
  }

  it('drops the inherited pin from projects of the other platform, and re-signs them', () => {
    const android = project('android', 'android', 'emulator-5554');
    const ios = project('ios', 'ios', 'emulator-5554');
    const iosSignature = ios.deviceSignature;
    scopeDevicePinToPlatform([android, ios], 'emulator-5554', 'android');
    expect(android.effectiveConfig.device).toBe('emulator-5554');
    expect(ios.effectiveConfig.device).toBeUndefined();
    expect(ios.deviceSignature).toBe(deviceSignature(makeConfig({ platform: 'ios' })));
    expect(ios.deviceSignature).not.toBe(iosSignature);
  });

  it('copies rather than mutating a config other projects (or the root) share', () => {
    const shared = makeConfig({ platform: 'ios', device: 'emulator-5554' });
    const ios = { ...project('ios', 'ios'), effectiveConfig: shared };
    scopeDevicePinToPlatform([ios], 'emulator-5554', 'android');
    expect(shared.device).toBe('emulator-5554');
    expect(ios.effectiveConfig.device).toBeUndefined();
  });

  it('keeps a project\'s own different pin', () => {
    const ios = project('ios', 'ios', 'SIM-1');
    scopeDevicePinToPlatform([ios], 'emulator-5554', 'android');
    expect(ios.effectiveConfig.device).toBe('SIM-1');
  });
});

// A pinned device hosts one worker — per device, not per bucket. Two projects
// for different apps are two buckets, both inheriting `--device`, and each got
// a worker on the one device.
describe('devicesPinnedByManyBuckets()', () => {
  function project(name: string, pin: Partial<TapsmithConfig>): ResolvedProject {
    const effectiveConfig = makeConfig({ platform: 'android', ...pin });
    return {
      name, testMatch: [], testIgnore: [], dependencies: [], testFiles: ['a.test.ts'],
      effectiveConfig, deviceSignature: deviceSignature(effectiveConfig),
    };
  }

  it('names a device two buckets are pinned to, with the projects', () => {
    const buckets = bucketizeProjects([
      project('app-a', { device: 'emulator-5554', package: 'a' }),
      project('app-b', { device: 'emulator-5554', package: 'b' }),
    ]);
    expect(devicesPinnedByManyBuckets(buckets, pinnedBucketSignatures(buckets)))
      .toEqual([{ serial: 'emulator-5554', projects: ['app-a', 'app-b'] }]);
  });

  it('is empty when every pinned bucket has its own device', () => {
    const buckets = bucketizeProjects([
      project('app-a', { device: 'emulator-5554', package: 'a' }),
      project('app-b', { device: 'emulator-5556', package: 'b' }),
    ]);
    expect(devicesPinnedByManyBuckets(buckets, pinnedBucketSignatures(buckets))).toEqual([]);
  });
});

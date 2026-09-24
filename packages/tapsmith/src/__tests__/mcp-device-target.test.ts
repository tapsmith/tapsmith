import { describe, it, expect } from 'vitest';
import { deviceClientFor } from '../mcp/tools/device-target.js';
import { selectProjectDevice, retiredUiConnections, sessionDevicesFrom } from '../mcp/connection.js';
import { uiDeviceChoiceError, type TestDispatcher } from '../mcp/test-dispatcher.js';

// A device tool used to fall back to the first pooled daemon whenever no
// `device` was given. A session holds one daemon per platform, so that answered
// for whichever platform resolved first — a screenshot taken while debugging an
// iOS failure could be the Android emulator's. `project` is how a caller says
// which it means: it is what run_tests already takes, and unlike a serial it is
// the same next session.

function dispatcherWith(projects: Array<{ name: string; platform?: string }>): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [],
    getProjects: () => projects.map((p) => p.name),
    getTestTree: () => [],
    getSessionInfo: () => ({
      timeout: 0,
      retries: 0,
      projects: projects.map((p) => ({
        name: p.name,
        platform: p.platform,
        testFiles: [],
        dependencies: [],
      })),
    }),
    resolveDeviceName: () => undefined,
    deviceChoiceError: async () => null,
    toggleWatch: () => ({ enabled: false }),
  };
}

describe('deviceClientFor project routing', () => {

  it('rejects a project the config does not declare, and says what it does', async () => {
    const dispatcher = dispatcherWith([
      { name: 'android', platform: 'android' },
      { name: 'ios', platform: 'ios' },
    ]);
    await expect(deviceClientFor({ project: 'iOS' }, dispatcher)).rejects.toThrow(
      /Unknown project "iOS".*android, ios/s,
    );
  });

  it('says so when a config declares no projects at all', async () => {
    await expect(deviceClientFor({ project: 'ios' }, dispatcherWith([]))).rejects.toThrow(
      /declares none/,
    );
  });

  it('points at `device` when the session cannot resolve project names', async () => {
    // No dispatcher: the tool has no way to map a name to a platform, so the
    // caller needs the escape hatch rather than a confusing "unknown project".
    await expect(deviceClientFor({ project: 'ios' }, undefined)).rejects.toThrow(
      /Pass `device` instead/,
    );
  });
});

describe('selectProjectDevice', () => {
  const android = { serial: 'EMU-1', platform: 'android' };
  const ios = { serial: 'SIM-1', platform: 'ios' };

  it('picks the device for the project\'s platform', () => {
    expect(selectProjectDevice([android, ios], { name: 'ios', platform: 'ios' }))
      .toEqual({ serial: 'SIM-1' });
  });

  // A root config that declares no platform gives its projects none either.
  // Reading that as "no project was named" fell through to the generic path,
  // whose message tells the caller to pass the `project` they just passed.
  it('treats a project with no platform as matching the session\'s unqualified device', () => {
    expect(selectProjectDevice([{ serial: 'SIM-1' }], { name: 'smoke' }))
      .toEqual({ serial: 'SIM-1' });
  });

  it('does not let a platform-less project match a platform-bound device', () => {
    const chosen = selectProjectDevice([android, ios], { name: 'smoke' });
    expect(chosen).toEqual({ error: expect.stringContaining('no device for project "smoke"') });
  });

  it('names the project, not just the platform, when there is no such device', () => {
    const chosen = selectProjectDevice([android], { name: 'ios', platform: 'ios' });
    expect(chosen).toEqual({ error: expect.stringContaining('no ios device for project "ios"') });
  });

  // Several devices for one project are that project's workers, and the caller
  // has already answered the only question they could. Refusing here left
  // `project` unable to select anything on a parallel run.
  it('takes the project\'s primary device when one platform has several', () => {
    const chosen = selectProjectDevice(
      [android, { serial: 'EMU-2', platform: 'android' }],
      { name: 'android', platform: 'android' },
    );
    expect(chosen).toEqual({ serial: 'EMU-1' });
  });

  it('picks the primary of the matching platform, not of the session', () => {
    const chosen = selectProjectDevice(
      [{ serial: 'SIM-1', platform: 'ios' }, android, { serial: 'EMU-2', platform: 'android' }],
      { name: 'android', platform: 'android' },
    );
    expect(chosen).toEqual({ serial: 'EMU-1' });
  });
});

// A UI worker that dies mid-run is retired and its daemon killed, but its
// connection kept the `preparedDevice` it was handed at discovery — and that is
// what `sessionTargetDevices` reads. So a two-worker session that lost one went
// on reporting two devices, refusing every device tool as ambiguous over a
// serial that no `device` or `project` argument could route to.
describe('retiredUiConnections', () => {
  const a = { address: '127.0.0.1:50151', source: 'ui' };
  const b = { address: '127.0.0.1:50152', source: 'ui' };

  it('drops a UI connection the server no longer lists', () => {
    expect(retiredUiConnections([a, b], [{ address: a.address }])).toEqual([b]);
  });

  it('keeps every UI connection while the server still lists it', () => {
    expect(retiredUiConnections([a, b], [{ address: a.address }, { address: b.address }]))
      .toEqual([]);
  });

  // The worker list says nothing about a daemon we started, adopted, or were
  // configured with — none of them appear in it even while perfectly alive.
  it('never drops a connection from another source', () => {
    const ours = [
      { address: '127.0.0.1:50051', source: 'started' },
      { address: '127.0.0.1:50052', source: 'peer' },
      { address: '127.0.0.1:50053', source: 'orphan' },
      { address: '127.0.0.1:50054', source: 'configured' },
    ];
    expect(retiredUiConnections(ours, [])).toEqual([]);
  });
});

// A daemon nothing claimed still names whichever device is Active, so the same
// serial can arrive twice: once tagged with the platform that claimed it, once
// bare. Last-writer-wins dropped the tag, and a valid `project` argument was
// then refused for a device the session was demonstrably driving.
describe('sessionDevicesFrom', () => {
  it('keeps the platform when an untagged connection reports the same serial', () => {
    const devices = sessionDevicesFrom([
      { preparedDevice: 'emulator-5554', platform: 'android' },
      { activeDevice: 'emulator-5554' },
    ]);
    expect(devices).toEqual([{ serial: 'emulator-5554', platform: 'android' }]);
    expect(selectProjectDevice(devices, { name: 'android', platform: 'android' }))
      .toEqual({ serial: 'emulator-5554' });
  });

  it('keeps the platform whichever order the connections arrive in', () => {
    expect(sessionDevicesFrom([
      { activeDevice: 'emulator-5554' },
      { preparedDevice: 'emulator-5554', platform: 'android' },
    ])).toEqual([{ serial: 'emulator-5554', platform: 'android' }]);
  });

  // `prepareTarget` points the daemon before starting the agent, and keeps
  // that record when the agent start throws — the daemon really did move. But
  // a device whose agent never started is not one the session can act on, and
  // counting it made every no-argument tool refuse as ambiguous over a target
  // that could not have served one.
  it('does not count a device whose agent failed to start', () => {
    expect(sessionDevicesFrom([
      { preparedDevice: 'SIM-1', platform: 'ios' },
      { preparedDevice: 'EMU-1', platform: 'android', agentFailed: true },
    ])).toEqual([{ serial: 'SIM-1', platform: 'ios' }]);
  });

  it('counts a device again once its agent starts', () => {
    expect(sessionDevicesFrom([
      { preparedDevice: 'EMU-1', platform: 'android', agentFailed: false },
    ])).toEqual([{ serial: 'EMU-1', platform: 'android' }]);
  });

  it('still reports one entry per device the session drives', () => {
    expect(sessionDevicesFrom([
      { preparedDevice: 'emulator-5554', platform: 'android' },
      { preparedDevice: 'SIM-1', platform: 'ios' },
      { activeDevice: undefined },
    ])).toEqual([
      { serial: 'emulator-5554', platform: 'android' },
      { serial: 'SIM-1', platform: 'ios' },
    ]);
  });
});

describe('uiDeviceChoiceError', () => {
  it('accepts the device of a one-worker session, by serial', () => {
    expect(uiDeviceChoiceError({ device: 'emulator-5554', serial: 'emulator-5554', sessionDevices: ['emulator-5554'], workerCount: 1 }))
      .toBeNull();
  });

  it('accepts a group member of a one-worker session by its name', () => {
    expect(uiDeviceChoiceError({ device: 'bob', serial: 'emulator-5556', sessionDevices: ['emulator-5554', 'emulator-5556'], workerCount: 1 }))
      .toBeNull();
  });

  it('refuses a device the session does not drive, listing the ones it does', () => {
    expect(uiDeviceChoiceError({ device: 'emulator-5560', serial: 'emulator-5560', sessionDevices: ['emulator-5554'], workerCount: 1 }))
      .toMatch(/emulator-5560 is not a device this UI session drives \(emulator-5554\)/);
  });

  it('refuses to pin a run when several workers could take it', () => {
    expect(uiDeviceChoiceError({ device: 'emulator-5554', serial: 'emulator-5554', sessionDevices: ['emulator-5554', 'emulator-5556'], workerCount: 2 }))
      .toMatch(/whichever of its 2 workers is free/);
  });
});

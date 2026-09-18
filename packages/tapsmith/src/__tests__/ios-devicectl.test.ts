import { describe, it, expect } from 'vitest';
import { parseDevicectlDeviceList } from '../ios-devicectl.js';

describe('parseDevicectlDeviceList', () => {
  it('parses a real unpaired iPhone entry', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            connectionProperties: {
              pairingState: 'unpaired',
              transportType: 'wired',
            },
            deviceProperties: {
              name: "Sam\u2019s iPhone",
              bootState: 'booted',
              ddiServicesAvailable: false,
              osVersionNumber: '26.2.1',
              developerModeStatus: 'enabled',
            },
            hardwareProperties: {
              platform: 'iOS',
              productType: 'iPhone17,1',
              udid: '00008140-00096C9014F3001C',
            },
            identifier: 'EBAACA98-F83F-5F5A-85A7-23F989DD5585',
          },
        ],
      },
    });
    const result = parseDevicectlDeviceList(json);
    expect(result).toHaveLength(1);
    const d = result[0]!;
    expect(d.udid).toBe('00008140-00096C9014F3001C');
    expect(d.name).toBe("Sam\u2019s iPhone");
    expect(d.isPaired).toBe(false);
    expect(d.ddiServicesAvailable).toBe(false);
    expect(d.osVersion).toBe('26.2.1');
    expect(d.bootState).toBe('booted');
    expect(d.developerModeStatus).toBe('enabled');
    expect(d.transportType).toBe('wired');
  });

  it('captures transportType for wireless-paired devices', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            connectionProperties: { pairingState: 'paired', transportType: 'localNetwork' },
            deviceProperties: { name: 'iPhone' },
            hardwareProperties: { platform: 'iOS', udid: 'UDID' },
          },
        ],
      },
    });
    expect(parseDevicectlDeviceList(json)[0]?.transportType).toBe('localNetwork');
  });

  it('falls back to "unknown" when developerModeStatus is absent', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            connectionProperties: { pairingState: 'paired' },
            deviceProperties: { name: 'iPhone', bootState: 'booted' },
            hardwareProperties: { platform: 'iOS', udid: 'UDID' },
          },
        ],
      },
    });
    expect(parseDevicectlDeviceList(json)[0]?.developerModeStatus).toBe('unknown');
  });

  it('filters out non-iOS entries (Apple Watch, Mac)', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            hardwareProperties: { platform: 'iOS', udid: 'IOS-UDID' },
            deviceProperties: { name: 'iPhone', bootState: 'booted' },
            connectionProperties: { pairingState: 'paired' },
          },
          {
            hardwareProperties: { platform: 'watchOS', udid: 'WATCH-UDID' },
            deviceProperties: { name: 'Apple Watch', bootState: 'booted' },
            connectionProperties: { pairingState: 'paired' },
          },
          {
            hardwareProperties: { platform: 'macOS', udid: 'MAC-UDID' },
            deviceProperties: { name: 'Mac', bootState: 'booted' },
            connectionProperties: { pairingState: 'paired' },
          },
        ],
      },
    });
    const result = parseDevicectlDeviceList(json);
    expect(result.map((d) => d.udid)).toEqual(['IOS-UDID']);
  });

  it('filters out simulators (Xcode 27 devicectl lists them as reality: simulated)', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            hardwareProperties: { platform: 'iOS', udid: 'REAL-UDID', reality: 'physical' },
            deviceProperties: { name: 'iPhone', bootState: 'booted' },
            connectionProperties: { pairingState: 'paired' },
          },
          {
            hardwareProperties: { platform: 'iOS', udid: 'SIM-UDID', reality: 'simulated' },
            deviceProperties: { name: 'iPhone 17', bootState: 'booted' },
            connectionProperties: { pairingState: 'paired' },
          },
          {
            // No reality field at all (pre-Xcode-27 output): real hardware.
            hardwareProperties: { platform: 'iOS', udid: 'OLD-XCODE-UDID' },
            deviceProperties: { name: 'iPhone 15', bootState: 'booted' },
            connectionProperties: {},
          },
        ],
      },
    });
    expect(parseDevicectlDeviceList(json).map((d) => d.udid)).toEqual(['REAL-UDID', 'OLD-XCODE-UDID']);
  });

  it('returns empty array for missing / malformed result', () => {
    expect(parseDevicectlDeviceList('{}')).toEqual([]);
    expect(parseDevicectlDeviceList('{"result":{"devices":"not-an-array"}}')).toEqual([]);
    expect(parseDevicectlDeviceList('{"result":{}}')).toEqual([]);
  });

  it('skips devices with empty udid', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            hardwareProperties: { platform: 'iOS' }, // no udid
            deviceProperties: { name: 'mystery', bootState: 'booted' },
          },
        ],
      },
    });
    expect(parseDevicectlDeviceList(json)).toEqual([]);
  });
});

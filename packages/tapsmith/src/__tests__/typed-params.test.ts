/**
 * Role, swipe-direction and key parameters are literal unions an editor can
 * autocomplete, yet still take any string (aliases, other casings, Android
 * key codes, iOS characters). The type-level checks run under
 * `npm run typecheck`; the parity checks pin the key list to the agents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Device, DeviceKey, ElementHandle, Role, SwipeDirection, TapsmithAssertions } from '../index.js';
import { DEVICE_KEYS } from '../input-names.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** The literal members of a `Literal | (string & {})` parameter (never for plain `string`). */
type Literals<T> = T extends string ? (string extends T ? never : T) : never;

describe('typed parameters', () => {
  it('offers the role union on every role parameter, and still takes any string', () => {
    expectTypeOf<Literals<Parameters<Device['getByRole']>[0]>>().toEqualTypeOf<Role>();
    expectTypeOf<Literals<Parameters<ElementHandle['getByRole']>[0]>>().toEqualTypeOf<Role>();
    expectTypeOf<Literals<Parameters<TapsmithAssertions['toHaveRole']>[0]>>().toEqualTypeOf<Role>();
    expectTypeOf<string>().toMatchTypeOf<Parameters<Device['getByRole']>[0]>();
    expectTypeOf<string>().toMatchTypeOf<Parameters<TapsmithAssertions['toHaveRole']>[0]>();
  });

  it('offers the direction union on swipe() and scroll(), and still takes any string', () => {
    expectTypeOf<Literals<Parameters<Device['swipe']>[0]>>().toEqualTypeOf<SwipeDirection>();
    expectTypeOf<Literals<Parameters<ElementHandle['scroll']>[0]>>().toEqualTypeOf<SwipeDirection>();
    type IntoView = Exclude<NonNullable<Parameters<ElementHandle['scrollIntoView']>[0]>['direction'], undefined>;
    expectTypeOf<Literals<IntoView>>().toEqualTypeOf<SwipeDirection>();
    expectTypeOf<string>().toMatchTypeOf<Parameters<Device['swipe']>[0]>();
  });

  it('offers the key union on pressKey(), and still takes any string', () => {
    expectTypeOf<Literals<Parameters<Device['pressKey']>[0]>>().toEqualTypeOf<DeviceKey>();
    expectTypeOf<string>().toMatchTypeOf<Parameters<Device['pressKey']>[0]>();
  });
});

describe('DEVICE_KEYS parity with the agents', () => {
  it('is exactly the names the Android agent resolves', () => {
    const source = read('agent/app/src/main/kotlin/dev/tapsmith/agent/ActionExecutor.kt');
    const from = source.indexOf('private fun resolveKeyCode');
    expect(from, 'resolveKeyCode not found').toBeGreaterThanOrEqual(0);
    const body = source.slice(from, source.indexOf('else ->', from));
    const names = [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!.toUpperCase());
    expect(names.length).toBeGreaterThan(10);
    expect([...DEVICE_KEYS].sort()).toEqual([...new Set(names)].sort());
  });

  it('covers every name the iOS agent handles', () => {
    const source = read('ios-agent/TapsmithAgent/ActionExecutor.swift');
    const from = source.indexOf('func pressKey(');
    expect(from, 'pressKey not found').toBeGreaterThanOrEqual(0);
    const body = source.slice(from, source.indexOf('default:', from));
    const names = [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!.toUpperCase());
    expect(names).toContain('HOME');
    for (const name of names) expect(DEVICE_KEYS as readonly string[]).toContain(name);
  });
});

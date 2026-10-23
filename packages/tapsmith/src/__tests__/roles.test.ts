/**
 * Native role names (PILOT-556): the SDK's role set is the one both agents
 * accept, and getByRole rejects anything else when the locator is built
 * instead of polling for 30s for a role no element can have.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ANDROID_DUAL_PATH_ROLES, ANDROID_ROLE_CLASSES, ANDROID_TRAIT_ONLY_ROLES, IOS_OTHER_ROLE_DESCRIPTIONS, IOS_ROLE_TYPES, IOS_STATIC_TEXT_ROLES, IOS_UNDESCRIBED_OTHER_ROLES, NATIVE_ROLES, ROLE_ALIASES, assertKnownRole, iosDescribedRole, iosGenericViewHasRole, normalizeRole, unknownRoleMessage } from '../roles.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** The text between `start` and the first `end` after it. */
function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `${end} not found after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('unknownRoleMessage()', () => {
  it('accepts every native role', () => {
    for (const role of NATIVE_ROLES) expect(unknownRoleMessage(role)).toBeNull();
  });

  it('accepts the cross-platform aliases', () => {
    for (const alias of ['header', 'slider', 'search', 'radio']) expect(unknownRoleMessage(alias)).toBeNull();
  });

  it('accepts the roles React Native publishes only as an Android role description (PILOT-664)', () => {
    for (const role of ['menu', 'menubar', 'menuitem', 'radiogroup', 'scrollbar', 'spinbutton', 'summary', 'tablist', 'timer']) {
      expect(unknownRoleMessage(role), role).toBeNull();
    }
  });

  it('matches case-insensitively, like the agents', () => {
    expect(unknownRoleMessage('Button')).toBeNull();
    expect(unknownRoleMessage('LISTITEM')).toBeNull();
    expect(unknownRoleMessage('Header')).toBeNull();
  });

  it('names the role and lists the supported ones', () => {
    const message = unknownRoleMessage('lst');
    expect(message).toMatch(/^Unknown role "lst"\. Supported: alert, button, checkbox, /);
    for (const role of NATIVE_ROLES) expect(message).toContain(role);
    expect(message).toContain('aliases: header → heading, slider → seekbar, search → searchfield, radio → radiobutton');
  });

  it('suggests the native role for a Playwright ARIA role name', () => {
    expect(unknownRoleMessage('textbox')).toContain('Did you mean "textfield"?');
    expect(unknownRoleMessage('img')).toContain('Did you mean "image"?');
    expect(unknownRoleMessage('searchbox')).toContain('Did you mean "searchfield"?');
    expect(unknownRoleMessage('dialog')).not.toContain('Did you mean');
  });

  it('points React Native\'s togglebutton at button, the role it reports (PILOT-664)', () => {
    expect(unknownRoleMessage('togglebutton')).toContain('Did you mean "button"?');
  });

  it('rejects an empty or whitespace-padded role', () => {
    expect(unknownRoleMessage('')).toMatch(/^Unknown role ""\./);
    expect(unknownRoleMessage(' button')).toMatch(/^Unknown role " button"\./);
  });
});

describe('assertKnownRole()', () => {
  it('throws the unknown-role message', () => {
    expect(() => assertKnownRole('lst', 'getByRole()')).toThrow(/^Unknown role "lst"\. Supported: /);
  });

  it('throws a TypeError for a non-string role', () => {
    expect(() => assertKnownRole(undefined, 'getByRole()')).toThrow(TypeError);
    expect(() => assertKnownRole(42, 'getByRole()')).toThrow('getByRole() expects a role name string, got a number.');
    expect(() => assertKnownRole(null, 'getByRole()')).toThrow('got null');
  });

  it('accepts a known role', () => {
    expect(() => assertKnownRole('scrollview', 'getByRole()')).not.toThrow();
  });
});

describe('normalizeRole()', () => {
  it('lowercases and resolves aliases', () => {
    expect(normalizeRole('Header')).toBe('heading');
    expect(normalizeRole('slider')).toBe('seekbar');
    expect(normalizeRole('search')).toBe('searchfield');
    expect(normalizeRole('Radio')).toBe('radiobutton');
    expect(normalizeRole('Button')).toBe('button');
  });
});

// ─── Parity with the agents ───
//
// Each agent rejects a role it does not know with its own "Unknown role"
// error, so a role the SDK accepts but an agent does not would still fail at
// the agent, and one the agent accepts but the SDK rejects would be
// unreachable. Read the agents' sources so drift fails here.

describe('role set parity with the agents', () => {
  it('matches the Android agent (roleClassMap + TRAIT_ONLY_ROLES)', () => {
    const source = read('agent/app/src/main/kotlin/dev/tapsmith/agent/ElementFinder.kt');
    const classMap = block(source, 'private val roleClassMap =', 'private val classToRoleMap');
    const classRoles = [...classMap.matchAll(/"([a-z]+)" to\s*\n\s*listOf\(/g)].map((m) => m[1]!);
    const traitOnly = block(source, 'val TRAIT_ONLY_ROLES', ')\n');
    const traitRoles = [...traitOnly.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
    expect(classRoles.length).toBeGreaterThan(10);
    expect([...classRoles, ...traitRoles].sort()).toEqual([...NATIVE_ROLES]);
  });

  it('matches the iOS agent (roleToElementTypes)', () => {
    const source = read('ios-agent/TapsmithAgent/RoleMapping.swift');
    const map = block(source, 'static let roleToElementTypes', 'static let reverseRolePins');
    const roles = [...map.matchAll(/^\s*"([a-z]+)": \[/gm)].map((m) => m[1]!);
    expect(roles.length).toBeGreaterThan(10);
    expect(roles.sort()).toEqual([...NATIVE_ROLES]);
  });

  it('has the same aliases as both agents', () => {
    const sdk = Object.entries(ROLE_ALIASES).sort();
    const kotlin = block(read('agent/app/src/main/kotlin/dev/tapsmith/agent/ElementFinder.kt'), 'val ROLE_ALIASES', ')\n');
    expect([...kotlin.matchAll(/"([a-z]+)" to "([a-z]+)"/g)].map((m) => [m[1], m[2]]).sort()).toEqual(sdk);
    const swift = block(read('ios-agent/TapsmithAgent/RoleMapping.swift'), 'static let roleAliases', ']\n');
    expect([...swift.matchAll(/"([a-z]+)": "([a-z]+)"/g)].map((m) => [m[1], m[2]]).sort()).toEqual(sdk);
  });

  it('has the Android agent\'s class names per role', () => {
    const classMap = block(read('agent/app/src/main/kotlin/dev/tapsmith/agent/ElementFinder.kt'), 'private val roleClassMap =', 'private val classToRoleMap');
    const kotlin: Record<string, string[]> = {};
    for (const m of classMap.matchAll(/"([a-z]+)" to\s*\n\s*listOf\(([^)]*)\)/g)) {
      kotlin[m[1]!] = [...m[2]!.matchAll(/"([\w.]+)"/g)].map((c) => c[1]!);
    }
    expect(ANDROID_ROLE_CLASSES).toEqual(kotlin);
  });

  it('has the Android agent\'s description-resolved roles (PILOT-656)', () => {
    const source = read('agent/app/src/main/kotlin/dev/tapsmith/agent/ElementFinder.kt');
    const roles = (start: string) => [...block(source, start, ')\n').matchAll(/"([a-z]+)"/g)].map((m) => m[1]!).sort();
    expect([...ANDROID_DUAL_PATH_ROLES].sort()).toEqual(roles('val DUAL_PATH_ROLES'));
    expect([...ANDROID_TRAIT_ONLY_ROLES].sort()).toEqual(roles('val TRAIT_ONLY_ROLES'));
    // React Native publishes these only as a role description on a generic view.
    for (const role of ['progressbar', 'toolbar', 'tablist']) expect(ANDROID_DUAL_PATH_ROLES).toContain(role);
    // …and these only as a description, on a generic View (PILOT-664). A tab
    // item has no class of its own on any toolkit (PILOT-514).
    for (const role of ['menu', 'menubar', 'menuitem', 'radiogroup', 'scrollbar', 'spinbutton', 'summary', 'tab', 'timer']) {
      expect(ANDROID_TRAIT_ONLY_ROLES).toContain(role);
    }
  });

  it('reads React Native\'s togglebutton (an android.widget.ToggleButton) as a button (PILOT-664)', () => {
    expect(ANDROID_ROLE_CLASSES.button).toContain('android.widget.ToggleButton');
  });

  it('has the iOS agent\'s element types per role, without .other', () => {
    const map = block(read('ios-agent/TapsmithAgent/RoleMapping.swift'), 'static let roleToElementTypes', 'static let reverseRolePins');
    const swift: Record<string, string[]> = {};
    for (const m of map.matchAll(/^\s*"([a-z]+)": \[([^\]]*)\]/gm)) {
      const types = [...m[2]!.matchAll(/\.(\w+)/g)].map((t) => t[1]!).filter((t) => t !== 'other');
      if (types.length > 0) swift[m[1]!] = types.map((t) => `XCUIElementType${t[0]!.toUpperCase()}${t.slice(1)}`);
    }
    expect(IOS_ROLE_TYPES).toEqual(swift);
  });

  it('has the iOS agent\'s generic-view role descriptions (PILOT-608, PILOT-664)', () => {
    const source = read('ios-agent/TapsmithAgent/RoleMapping.swift');
    const table = (start: string) => Object.fromEntries(
      [...block(source, start, ']\n').matchAll(/"([a-z]+)": "([a-z ]+)"/g)].map((m) => [m[1]!, m[2]!]),
    );
    expect(IOS_OTHER_ROLE_DESCRIPTIONS).toEqual(table('static let otherRoleDescriptions'));
    const undescribed = [...block(source, 'static let undescribedOtherRoles', ']\n').matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
    expect([...IOS_UNDESCRIBED_OTHER_ROLES].sort()).toEqual(undescribed.sort());
    const staticText = [...block(source, 'static let staticTextRoles', ']\n').matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
    expect([...IOS_STATIC_TEXT_ROLES].sort()).toEqual(staticText.sort());
  });

  it('lists NATIVE_ROLES sorted, so the error message reads alphabetically', () => {
    expect([...NATIVE_ROLES]).toEqual([...NATIVE_ROLES].sort());
  });
});

// ─── iOS generic views (mirrors RoleMapping.matches) ───

describe('iosDescribedRole()', () => {
  it('reads RN\'s description from the first part of the value only', () => {
    expect(iosDescribedRole('checkbox, unchecked')).toBe('checkbox');
    expect(iosDescribedRole(' Radio Button , selected')).toBe('radiobutton');
    expect(iosDescribedRole('combo box')).toBe('combobox');
    expect(iosDescribedRole('50%, checkbox')).toBe('');
    expect(iosDescribedRole('')).toBe('');
    expect(iosDescribedRole(undefined)).toBe('');
  });
});

describe('iosGenericViewHasRole()', () => {
  const view = (value: string | undefined, opts: { traitRole?: string; named?: boolean } = {}) =>
    ({ value, traitRole: opts.traitRole ?? '', named: opts.named ?? false });

  it('leaves roles matched by type or trait to the caller', () => {
    expect(iosGenericViewHasRole('button', view(undefined, { named: true }))).toBeUndefined();
    expect(iosGenericViewHasRole('heading', view(undefined, { named: true }))).toBeUndefined();
  });

  it('matches RN\'s described checkbox and radio, and nothing else by that description', () => {
    expect(iosGenericViewHasRole('checkbox', view('checkbox, unchecked'))).toBe(true);
    expect(iosGenericViewHasRole('radiobutton', view('Radio button, checked'))).toBe(true);
    expect(iosGenericViewHasRole('checkbox', view('radio button, checked', { named: true }))).toBe(false);
    expect(iosGenericViewHasRole('menuitem', view('checkbox, checked', { named: true }))).toBe(false);
  });

  it('finds an undescribed, untraited generic view only by a named query', () => {
    for (const role of ['alert', 'menuitem', 'timer', 'summary']) {
      expect(iosGenericViewHasRole(role, view(undefined)), role).toBe(false);
      expect(iosGenericViewHasRole(role, view(undefined, { named: true })), role).toBe(true);
      expect(iosGenericViewHasRole(role, view(undefined, { named: true, traitRole: 'button' })), role).toBe(false);
    }
  });

  it('treats a value leading with a new role\'s word as the app\'s own text', () => {
    // RN's new architecture publishes no description for these roles.
    expect(iosGenericViewHasRole('timer', view('Timer'))).toBe(false);
    expect(iosGenericViewHasRole('combobox', view('Timer', { named: true }))).toBe(true);
    expect(iosGenericViewHasRole('menu', view('Menu', { named: true, traitRole: 'button' }))).toBe(false);
  });
});

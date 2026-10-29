import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Internal tracker keys (`PILOT-123`) mean nothing to users, so none may reach
// the published type declarations, whose JSDoc an editor shows on hover. The
// declarations are emitted in memory from the package's own build config, so
// the check needs no build.
describe('published type declarations', () => {
  it('carry no internal ticket refs', () => {
    // Vitest runs from the package root (no @types/node here for a path join).
    const root = ts.sys.getCurrentDirectory();
    const { config } = ts.readConfigFile(`${root}/tsconfig.build.json`, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: false });
    const declarations: string[] = [];
    const refs: string[] = [];
    program.emit(undefined, (fileName, text) => {
      if (!fileName.endsWith('.d.ts')) return;
      declarations.push(fileName);
      text.split('\n').forEach((line, i) => {
        if (/\bPILOT-\d+\b/.test(line)) refs.push(`${fileName.slice(fileName.lastIndexOf('/') + 1)}:${i + 1}: ${line.trim()}`);
      });
    }, undefined, true);
    expect(declarations.length).toBeGreaterThan(3);
    expect(refs).toEqual([]);
  });
});

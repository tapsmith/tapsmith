// Types for clean-install-checks.mjs, so the unit tests can import it.

export interface InstallScriptEntry {
  name: string;
  version: string;
  line: string;
}

export interface PackedFile {
  path: string;
  mode?: number;
}

export declare const ALLOWED_INSTALL_SCRIPTS: Readonly<Record<string, string>>;
export declare function parseInstallScriptWarnings(output: string): {
  entries: InstallScriptEntry[];
  unrecognised: string[];
};
export declare function disallowedInstallScripts(
  entries: InstallScriptEntry[],
  allowed?: Readonly<Record<string, string>>,
): InstallScriptEntry[];
export declare function npmReportsInstallScripts(version: string): boolean;
export declare function deprecationLines(output: string): string[];

export interface PackEntry {
  filename: string;
  files: Required<PackedFile>[];
  entryCount: number;
  size: number;
  unpackedSize: number;
}

export declare function packEntry(stdout: string): PackEntry;
export declare function testPaths(files: PackedFile[]): string[];
export declare function installScriptsOf(pkg: { scripts?: Record<string, string> }): string[];
export declare function nonExecutableFiles(files: Required<PackedFile>[], names: string[]): string[];
export declare function undeclaredPlatformFields(pkg: { name: string; os?: unknown; cpu?: unknown; libc?: unknown }): Array<'os' | 'cpu' | 'libc'>;

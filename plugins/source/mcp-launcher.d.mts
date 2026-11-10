// Types for mcp-launcher.mjs, so the unit tests in packages/tapsmith can import it.

export declare function projectDir(env: Record<string, string | undefined>, cwd: string): string;
export declare function tapsmithBinFrom(dir: string): { bin: string; version: string } | undefined;
export declare function locateTapsmith(
  start: string,
): { dir: string; bin: string; version: string; error?: undefined } | { error: string };
export declare function main(extraArgs: string[]): Promise<void>;

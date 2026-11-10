// Types for sync.mjs, so the unit tests in packages/tapsmith can import it.

export declare function launcherScript(source: string): string;
export declare function generatedFiles(root?: string): Record<string, string>;
export declare function staleFiles(root?: string): string[];

// Types for docs-bundle.mjs, so the unit tests can import it.

export declare const IMAGE_BASE_URL: string;
export declare function bundledPage(markdown: string): string;
export declare function docPages(docsDir: string): string[];
export declare function bundleDocs(docsDir: string, outDir: string): string[];

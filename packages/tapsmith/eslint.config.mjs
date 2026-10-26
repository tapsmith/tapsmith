import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      semi: ['error', 'always'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The device agents are the only locator matcher (PILOT-848). The
      // TypeScript re-implementation answers only for recorded hierarchies —
      // the offline trace playground — so nothing else may import it.
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/selector-matching*', '**/selector-uniqueness*', '**/selector-pick*'],
          message: 'The TypeScript locator matcher is only for the offline trace playground (PILOT-848). Ask the device: mcp/sdk-device.ts withEvaluatedLocator, ui-mode/live-locators.ts, or evaluateSelectors.',
        }],
      }],
    },
  },
  {
    // The offline trace playground, and the MCP suggestion builder, which
    // only parses its own generated candidate code to derive variants.
    files: [
      'src/trace-viewer/components/**',
      'src/trace-viewer/main.tsx',
      'src/mcp/agent-suggestions.ts',
      'src/__tests__/**',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
);

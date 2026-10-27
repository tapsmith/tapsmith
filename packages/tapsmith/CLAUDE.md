# TypeScript SDK (`packages/tapsmith/`)

Checks (CI's `typescript` job runs all of them): `npm run typecheck`, `npm run lint`,
`npm run test` (unit tests, no device), `npm run knip` (unused code), `npm run build`.

## TypeScript conventions

- **ESM with `.js` extensions** in all imports (even for `.ts` files) — required by Node16 module resolution
- **`_prefix`** for internal/private members (e.g., `_client`, `_selector`)
- **Section dividers**: `// ─── Name ───` in major files
- **Type exports** use explicit `type` keyword
- **No barrel exports** — `index.ts` has explicit re-exports
- **No `any`** — use `unknown` with type narrowing, or a targeted `eslint-disable` with a justification comment for genuinely untyped boundaries (e.g., dynamic proto loading)
- Unit tests use Vitest with mocks (no live device)

## The five run paths (embedders)

Tests execute through five separately-assembled paths. **Anything threaded
per-session — capabilities, install checks, passthrough hosts, new config
keys — must be wired through all of them**, or the missed path degrades
silently (this class of bug has shipped more than once):

1. `cli.ts` — sequential `tapsmith test` (the only path device CI exercises)
2. `worker-runner.ts` — parallel workers (`--workers N`, dispatcher.ts)
3. `ui-mode/ui-worker.ts` — every UI-mode session
4. `watch-run.ts` — headless watch mode's fresh-forked child per re-run
5. `mcp/headless-dispatcher.ts` — `tapsmith mcp-server`, which forks the same
   `watch-run.ts` children (so 4 and 5 share child code but have separate
   parent-side state threading)

A once-per-session warning about the app itself belongs in the shared session
layer every path opens through (`device-session.ts` → `session-preflight.ts`),
not in one embedder, and should reach the user as a `PreflightNotice` (the runner
turns it into a test-result warning, which every path shows) rather than
`console.warn` (UI-mode and MCP children's stderr reaches no user). The missing
`@tapsmith/react-native` hooks warning (PILOT-774) works this way. The runner
passes `executeAppReset` a fresh spread of the session context per reset, so
per-session state must live in a shared object, not a scalar on the context.

When adding a per-session concern, prefer a **required** option on
`runTestFile` over an optional one — a compile error in every embedder beats
a silent default (see `RunOptions.resetCapabilities` and `RunOptions.runMode`
for the precedent), and verify degraded paths loudly (assert the trace's
reset rung, not just pass/fail).

Anonymous usage telemetry (`telemetry.ts`, PILOT-330) rides on this: the
runner reports one event per file tagged with the embedder's `runMode`. Keep
the payload a closed set of fields (the unit test pins the key list) and never
add anything identifying — `docs/telemetry.md` is the public contract.

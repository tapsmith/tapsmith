# Watch Mode

Tapsmith's watch mode provides fast terminal-based iteration by keeping the daemon, device, and agent alive across re-runs. This eliminates the setup overhead that dominates cold test runs, bringing re-run times down to roughly 1-2 seconds.

## Starting watch mode

```bash
npx tapsmith test --watch
npx tapsmith test -w
```

You can combine `--watch` with other flags:

```bash
npx tapsmith test --watch --workers 2
npx tapsmith test -w tests/login.test.ts
```

## How it works

Watch mode starts the daemon, connects to a device, installs the agent, and then enters a persistent loop:

1. **Watches test files** using [chokidar](https://github.com/paulmillr/chokidar). The set of watched files is determined by the `testMatch` patterns in your config (default: `**/*.test.ts` and `**/*.spec.ts`).
2. **On file change**, forks a child process to run just the changed file. Each re-run gets a fresh Node.js ESM module cache, so changes to test files, helper modules, and page objects are all picked up automatically.
3. **Only re-runs the changed file** -- not the entire suite. If you change `tests/login.test.ts`, only that file runs.

The persistent device session is what makes this fast. A normal `npx tapsmith test` run pays the full cost of daemon startup, device detection, agent installation, and app launch on every invocation. Watch mode pays that cost once and then only resets the app before each re-run.

## Keyboard shortcuts

While watch mode is running, these keys are available:

| Key | Action |
|---|---|
| `a` | Run all test files |
| `f` | Re-run only previously failed tests |
| `Enter` | Re-run the last file(s) that were executed |
| `q` | Quit watch mode |

## Configuration

Watch mode uses the same `tapsmith.config.ts` as normal runs. No additional configuration is needed. The `testMatch` patterns control which files are watched, and all other options (timeout, retries, screenshot mode, trace config, etc.) apply as usual.

Watch mode also works with [projects](ui-mode.md#multi-project-support). When your config defines multiple projects, watch mode detects which project(s) a changed file belongs to and re-runs it on the correct device. If a file matches multiple projects (e.g. both an Android and iOS project share `**/*.test.ts`), it re-runs on all matching devices.

## Multi-worker watch

When `workers > 1` and multiple devices are available, watch mode initializes a pool of persistent worker processes -- one per device. Re-runs are dispatched to available workers using work-stealing, so parallel re-runs happen naturally when you save multiple files in quick succession.

```bash
npx tapsmith test --watch --workers 4
```

Each worker gets its own daemon instance and device connection. Workers remain alive for the duration of the watch session.

If only one device is available despite `workers > 1`, watch mode falls back to single-worker mode automatically.

A pinned device (`--device`, or `device` in the config) hosts one worker, so watch mode stays on exactly that device whatever `workers` says, and prints a note when it caps the count. `--device` combined with a `--workers N` the pin leaves unusable (in a single-platform config, any N > 1 when there is more than one file to spread) is refused.

## New file detection

Watch mode detects new test files added while it is running. If you create a new file that matches your `testMatch` patterns, it is picked up and run immediately. Deleted files are removed from the watch set.

Changes to the config file (`tapsmith.config.ts`) are detected but not hot-reloaded. Watch mode prints a message asking you to restart.

## Comparison with UI mode

| Feature | `test` | `--watch` | `--ui` |
|---|---|---|---|
| Fast re-run | No (full setup each time) | Yes (persistent session) | Yes (persistent session) |
| File watching | No | Yes | Yes (toggle per file) |
| Interactive UI | No | No (terminal only) | Yes (browser) |
| MCP server | No | No | Yes (SSE endpoint) |
| Multi-worker | Yes | Yes | Yes |
| Keyboard shortcuts | No | Yes (a/f/Enter/q) | N/A (browser UI) |
| Trace viewer integration | Post-run only | Post-run only | Inline in results |

## Tips

- **Use watch mode for focused development.** When you are iterating on a single test or a small set of tests, `--watch` gives you the fastest feedback loop without leaving the terminal.
- **Use [UI mode](ui-mode.md) for exploration and debugging.** When you need to browse results, inspect traces, or let an AI agent drive the tests, UI mode provides the richer interface.
- **Watch and UI are mutually exclusive.** If you pass both `--watch` and `--ui`, the UI takes precedence (it has its own built-in watch capability).
- **Sharding is not supported.** Neither watch mode nor UI mode can be combined with `--shard`, since both are designed for interactive local development rather than CI distribution.

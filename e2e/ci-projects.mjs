import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// ─── CI project layout, shared by the iOS and Android CI configs ───
//
// Playwright-style auth setup: the `authentication` project logs in once and
// saves the app container to AUTH_STATE_PATH; the `authenticated` project
// restores it before each of its files.
//
// In CI the workflows cache that archive across runs (actions/cache, keyed on
// the test-app build + the auth setup sources) and restore it before the test
// step. When the archive is already on disk we drop the `authentication`
// project and the `dependencies` edge entirely, so the ~80 s (iOS) login flow
// only runs on a cache miss. `use.appState` is applied by the runner
// regardless of whether the project declares dependencies, so the restore
// path is unchanged.

export const AUTH_STATE_PATH = "./tapsmith-results/auth-state-authentication.tar.gz"

const AUTHENTICATED_FILES = ["**/app-state.test.ts", "**/auth-gate.test.ts"]

/**
 * @param {{ testIgnore: string[] }} opts — extra ignore globs for the default
 *   project (the other platform's `*.<os>.test.ts` files).
 */
export function ciProjects({ testIgnore }) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const authStateRestored = fs.existsSync(path.resolve(here, AUTH_STATE_PATH))

  const defaultProject = {
    name: "default",
    testMatch: ["**/*.test.ts"],
    // Device-group tests need two devices per test; they run under the
    // dedicated `*-multi` configs only.
    testIgnore: [...AUTHENTICATED_FILES, "**/multi-device/**", "**/macos/**", ...testIgnore],
  }
  const authenticated = {
    name: "authenticated",
    use: { appState: AUTH_STATE_PATH },
    testMatch: AUTHENTICATED_FILES,
  }

  if (authStateRestored) {
    return [defaultProject, authenticated]
  }
  return [
    {
      name: "authentication",
      testMatch: ["**/auth.setup.ts"],
    },
    defaultProject,
    { ...authenticated, dependencies: ["authentication"] },
  ]
}

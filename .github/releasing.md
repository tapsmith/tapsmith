# Releasing Tapsmith

**Cutting a release (automated).** Run the **Prepare release** workflow from the Actions tab (`.github/workflows/prepare-release.yml`) with a version input of `patch`, `minor`, `major`, or an explicit version like `0.4.0`. It runs `scripts/bump-version.sh` and opens a labelled `Release vX.Y.Z` PR (CI runs on it). Review and merge the PR — merging triggers:

1. **`tag-release.yml`** — reads the version that landed on `main`, tags that commit `vX.Y.Z`, and pushes the tag (over SSH so `release.yml` fires).
2. **`release.yml`** — the existing publish pipeline (triggered by the `v*` tag), which now ends with a **`github-release`** job that creates the GitHub Release with auto-generated notes and dispatches `deploy-website.yml`.
3. **`deploy-website.yml`** — rebuilds the docs site; `website/scripts/sync-releases.mjs` fetches the published releases into the **Changelog** page (in the docs sidebar).

Release notes are grouped by PR label per `.github/release.yml` (Features/Bug Fixes/Docs/Maintenance/Other) and published both on the repo's **Releases** page and the website **Changelog**. Label your PRs (`enhancement`, `bug`, `documentation`, …) to control grouping.

**One-time setup (already done):** a repo **deploy key with write access** whose private half is stored as the secret **`RELEASE_SSH_KEY`**. It's required because the default `GITHUB_TOKEN` cannot trigger further workflow runs — so the release branch (for CI on the PR) and the version tag (for `release.yml`) are pushed over SSH with this key instead. Both automation workflows fail with a clear message if the secret is unset. To rotate: `ssh-keygen -t ed25519 -f k -N ""`, `gh repo deploy-key add k.pub -w -t release-automation`, `gh secret set RELEASE_SSH_KEY < k`, then delete the old deploy key.

**Manual escape hatch:** pushing a `v*` tag by hand (`git tag v0.4.0 && git push --tags`) still triggers `release.yml` directly, which then creates the Release and redeploys the website.

The release workflow (`.github/workflows/release.yml`) builds and publishes:

- **`@tapsmith/core-{darwin,linux}-{arm64,x64}`**: Platform-specific packages containing only the prebuilt `tapsmith-core` binary. Listed as `optionalDependencies` so npm auto-installs only the matching platform.
- **`@tapsmith/agent-android`**: Android agent APKs. Listed as an `optionalDependency` of the main package and auto-installed on any platform.
- **`tapsmith`**: Main package. Bundles the TypeScript SDK, CLI, proto file (`dist/proto/`), and trace viewer/UI mode web apps.

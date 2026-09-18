# DCO app administration

Tapsmith uses the external [DCO GitHub App](https://github.com/apps/dco), not a repository
workflow. The contribution policy is in [CONTRIBUTING.md](../CONTRIBUTING.md), and the
canonical certificate is in [DCO](../DCO).

The app is installed for `tapsmith/tapsmith`. The active `main` ruleset requires the
**DCO** check specifically from app ID **1861**, alongside its existing PR, deletion and
force-push protections.

## Installation and enforcement

1. Install the app for **tapsmith/tapsmith** using **Only select repositories**.
2. Land [.github/dco.yml](dco.yml) on `main`; the app reads configuration from the default
   branch. Maintainers are included, individual remediation is enabled, and third-party
   remediation is disabled.
3. Verify that an ordinary signed-off PR and an automated release PR receive a successful
   **DCO** check. An unsigned human commit should fail. Test release identity without
   merging or publishing a release.
4. In the `main` ruleset, require **DCO** with the **DCO app** as its expected source.
   Preserve the existing required checks.

The app needs read access to repository contents, merge queues, pull requests and metadata,
and write access to checks. Inspect GitHub's installation screen for the complete current
permissions.

## Release automation

`prepare-release.yml` authors generated version bumps as GitHub's `github-actions[bot]`
account using `41898282+github-actions[bot]@users.noreply.github.com`. The app exempts
GitHub-recognised bots; a custom Git name ending in `[bot]` is not enough. Human edits to
release branches still need sign-offs. Branch and tag pushes continue to use the existing
deploy key so GitHub Actions runs are triggered.

## Review and recovery

The app exempts merge commits. Review conflict resolutions and preserve sign-offs when
squashing or otherwise rewriting commits. A green check records compliance with the app's
rules; it does not prove ownership of the code.

For a missing or stale check, use the app's re-run control or follow its
[recheck instructions](https://github.com/dcoapp/app#how-it-works). Authors can follow a
failed check's individual remediation instructions without rewriting shared history.
The app also provides a maintainer override; use it only for an understood exception and
record the reason in the PR. An outage or a missing installation does not establish that
a contribution has been certified.

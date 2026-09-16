<!--
Thanks for contributing to Tapsmith!

For anything beyond a small fix, please open an issue first and say you intend to
work on it -- see CONTRIBUTING.md.
-->

## What this changes

<!-- What does this do, and why? Link the issue it closes, if there is one. -->

- Closes #

## How it was tested

<!--
Which checks did you run, and on what? For device-affecting changes, say which
platform and whether it was an emulator/simulator or a physical device.
-->

## Checklist

<!-- If an item genuinely doesn't apply, write [na] instead of ticking it. -->

- [ ] My contributions are signed off (`git commit -s`, or individual remediation) -- see [the contribution guide](https://github.com/tapsmith/tapsmith/blob/main/CONTRIBUTING.md#sign-off-your-commits)
- [ ] Existing tests pass
- [ ] New behaviour is tested at the lowest tier that can actually cover it -- a Vitest unit
      test if it needs no device, an `e2e/` test if it does. Some changes (the Android and iOS
      agents especially) can only be covered by `e2e/`, and some can't reasonably be tested at
      all -- if that's the case here, say so above rather than ticking this
- [ ] `docs/api-reference.md` is updated, if this changes public API
- [ ] Proto changes are handled in both the TypeScript SDK and the Rust daemon, if applicable

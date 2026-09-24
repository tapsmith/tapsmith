# Promo video pipeline

Generates `tapsmith-promo.mp4` — a ~132s promotional video (1080p30, voiceover,
music, real screen recordings of UI mode, the locator playground, a two-device
run and the trace viewer, plus synthetic scenes: a YAML-flow -> TypeScript
morph with an autocomplete moment, and an MCP-server scene showing an agent
inspecting the screen, writing and running a test).

The video is defined as a deterministic timeline in **`comp.html`**
(`window.seekComp(t)` renders the exact frame for any time `t`), rendered
frame-by-frame in headless Chrome, then assembled with ffmpeg.

The dramatic turn is **`BEAT`** (17.0s): the problem section runs cold (glow
off, red crosses, greyed YAML under a "status quo" caption, a thin two-chord
bed), the music rests while "Tapsmith is the next step." is spoken, and the
chord hit, thump, warm bloom, logo flash and YAML->TypeScript morph all land
as the phrase ends. `BEAT` lives in `comp.html` and `synth-music.py`; the 2a/2b
`adelay`s in `assemble.sh` are placed around it.

One more synthetic beat sits on top of real footage: the trace-viewer scene
opens on a failed CI job with its `trace.zip` artifact and
`npx tapsmith show-trace` typed in a terminal (`TRACE_INTRO`) before the
viewer slides in — the VO walks through exactly that workflow. The
multi-device scene shows the test's code through the real UI instead:
`record-multi.mjs` opens the Source tab before the run, and rewrites the
absolute path in its header to the neutral one live (a MutationObserver in
the page), so no patch is needed there.

## Prerequisites

- **ffmpeg** (`brew install ffmpeg`)
- **Google Chrome** at `/Applications/Google Chrome.app` (or any Chrome via `CHROME_PATH`)
- **Node 22+** — on Apple Silicon make sure `node` resolves to an **arm64**
  build (the Claude/Rosetta x64 trap breaks the UI-mode recording step; see
  the note in `record-ui` below)
- **Python 3** with a venv for audio: `python3 -m venv venv && ./venv/bin/pip install edge-tts numpy`
  (a venv created under Rosetta has x86_64 numpy — run those scripts with
  `arch -x86_64 ./venv/bin/python …` from an arm64 shell, or recreate the venv)
- `npm install` in this directory (installs `puppeteer-core`)

## Quick rebuild (no devices needed)

The checked-in `clip-*.mp4` files are the finished screen recordings, so
tweaking text, timing, scenes, or audio never touches a device:

```bash
# 1. Voiceover (only if vo/lines.txt changed)
while IFS='|' read -r n text; do
  ./venv/bin/edge-tts --voice en-US-AndrewMultilingualNeural --rate=-4% \
    --text "$text" --write-media "vo/seg$n.mp3"
done < vo/lines.txt
# (seg2a "Tapsmith is the next step." is synthesized at --rate=-10% so it can
# breathe in the rest; seg8, the feature list, at --rate=+8% to fit its scene)

# 2. Music bed (deterministic synth; regenerates music.wav)
./venv/bin/python synth-music.py

# 3. Render all frames at 2x (≈10 min), or a subrange for quick edits
node render-comp.mjs full 2              # everything
node render-comp.mjs full 2 738 1315     # only the UI-mode scene, for example
node render-comp.mjs probe               # quick QC stills at key timestamps

# 4. Assemble final mp4
./assemble.sh

# Quick check of one section without a full render: render just its frames,
# then mux them with the corresponding slice of the audio mix
node render-comp.mjs full 2 240 850 && ./assemble.sh preview 8 28   # -> preview.mp4
```

If you change VO timing or scene boundaries, keep `comp.html`'s `T` timeline,
the `adelay` values in `assemble.sh`, and the gain automation in
`synth-music.py` in sync.

## Re-recording the screen captures

Only needed if the product UI changed. Every recorder injects a synthetic
cursor + click ripples and captures via CDP screencast into `*-frames/` with
timestamps; `build-clips.py` then retimes them into 30fps clips (capping idle
gaps and jump-cutting the live test run). It builds whichever `*-frames/`
directories exist, so move stale ones out of the way (e.g. into `.stash/`)
before rebuilding a single clip. The UI-mode cut solves each segment's speed
from a target duration, so a faster or slower live run lands on the same
~23.6s clip.

**Trace viewer** (no device needed):

```bash
node server.mjs &          # serves the bundled viewer + demo-trace.zip on :4820
node record.mjs            # choreographed click-through -> rec-frames/
```

`demo-trace.zip` is a real failing gestures-test trace with the personal
filesystem path rewritten to `/Users/dev/acme-mobile`. To use a different
trace, scrub it the same way before recording. It is a format-v1 trace, whose
`trace.json`, `metadata.json` and `sources.json` all contain absolute paths.
Format-v2 traces record those paths relative to the project root, but error
messages and stacks can still name absolute paths.

**UI mode** (boots/claims a simulator — coordinate with whoever is using it):

```bash
# Launch the UI server WITHOUT it popping a browser, and with an arm64 node
# first on PATH so tsx-forked discovery children don't hit the Rosetta/esbuild
# arch mismatch (symptom: "Discovery error" for every file, 0 discovered):
mkdir -p shim && printf '#!/bin/sh\nexit 0\n' > shim/open && chmod +x shim/open
ln -sf "$HOME/.nvm/versions/node/v22.21.0/bin/node" shim/node
cd ../../e2e && PATH="$(pwd)/../tools/promo/shim:$PATH" \
  node node_modules/.bin/tapsmith test --ui --ui-port 4830 --workers 1 -c tapsmith.config.ios.mjs &
cd ../tools/promo && node record-ui.mjs      # runs the network-mocking test live
python3 build-clips.py                       # rebuild clip-ui.mp4 / clip-trace.mp4
```

After rebuilding `clip-ui.mp4`, regenerate the SOURCE-row patch table: the
Call tab shows the running test file's **absolute path** (during the run it
auto-shows each action's panel, so the row appears many times at varying
heights). `detect-paths.py` scans every frame for it (continuous monospace
run in the value column reaching far right) and writes `patch-table.js`,
which `comp.html` uses to cover the row with a neutral path, frame-accurately:

```bash
./venv/bin/python detect-paths.py   # clip-ui.mp4 -> patch-table.js
node probe-s3.mjs 30 33 36 40       # spot-check stills of the patched scene
```

After every full render, run the leak sweep, which re-detects path-like rows
in the rendered S3 frames and verifies each one is covered by an active patch
run (it accounts for the scene's zoom drift and clip playback rate):

```bash
./venv/bin/python sweep-s3.py       # expect "0 uncovered path-like rows"
```

`clip-ui-session.mp4` is a full-session archive cut (near-real pacing) kept
so future re-cuts of the UI scene don't require a simulator: point
`build-clips.py` at it (or keep the raw `ui-frames/` around) instead of
re-recording.

**Multi-device** (the S3.8 scene; boots/claims TWO simulators — Tapsmith clones
a second `iPhone 17` if only one is booted):

```bash
cd ../../e2e && PATH="$(pwd)/../tools/promo/shim:$PATH" \
  node node_modules/.bin/tapsmith test --ui --ui-port 4830 -c tapsmith.config.ios-multi.mjs &
cd ../tools/promo && node record-multi.mjs   # runs the two-user chat test live
python3 build-clips.py                       # -> clip-multi.mp4 (+ session archive)
```

The chat test hosts its own HTTP server, so the two mirrors show real messages
crossing between the devices; afterwards the recorder selects the assertion
that bob saw alice's message (two screenshot panes, acting device outlined)
and opens the Network tab (one filter pill per device).

**MCP panel** (the S3.5 scene's right-hand footage; claims the simulator):

```bash
# Restore the recording prop: the test the "agent" writes must really exist
cp api-error.test.ts.fixture ../../e2e/tests/api-error.test.ts
# Fresh server is REQUIRED — the MCP feed replays server-side history, so a
# reused server leaks old entries (including failed runs, whose result text
# contains the real trace path) into the recording.
cd ../../e2e && PATH="$(pwd)/../tools/promo/shim:$PATH" \
  node node_modules/.bin/tapsmith test --ui --ui-port 4830 --workers 1 -c tapsmith.config.ios.mjs &
cd ../tools/promo && PATH="$(pwd)/shim:$PATH" node record-mcp.mjs
python3 build-clips.py            # -> clip-mcp.mp4 (right-column crop) + session archive
rm ../../e2e/tests/api-error.test.ts
```

**Locator playground** (the S3.7 scene; claims the simulator): same server
setup as the MCP recording, then `node record-pick.mjs` — it warms the
session with a headless MCP run (set `SKIP_RUN=1` if the app is already on
the API Calls screen), toggles pick mode, hovers the mirror, and picks the
"Fetch 404" button so the Locator tab fills with generated locators.
`probe-pick.mjs` captures the mirror-canvas rect + a screenshot for
recalibrating the hover fractions if the app layout changes.

`record-mcp.mjs` drives the choreography and spawns `mcp-client.mjs`, a real
MCP client (SDK from packages/tapsmith) that presents itself as `claude-code`
and executes `tapsmith_list_tests` / `tapsmith_snapshot` /
`tapsmith_run_tests` on cue — every feed entry in the footage is a real tool
call. The snapshot beat is deliberate: validated locator suggestions and
trace reading are what set Tapsmith's MCP apart from the device-driving MCPs
Maestro and Appium ship, so the agent is shown reading the live screen before
it writes the test. A passing run's feed shows no absolute paths (verified); a FAILED run
does (trace path in the result), so if the on-camera run fails, restart the
server and re-take rather than shipping those frames.

## Docs / website screenshots

`docs-shots/shoot.mjs` captures the four UI screenshots in `docs/images/`
(copied to `website/public/` by the site build) at 1512x828 @2x, driving the
real product the same way the promo recorders do:

```bash
# two-platform UI mode (e2e/tapsmith.config.mjs: Android emulator + iPhone 17)
cd ../../e2e && PATH="$(pwd)/../tools/promo/shim:$PATH" \
  node node_modules/.bin/tapsmith test --ui --ui-port 4830 -c tapsmith.config.mjs &
cd ../tools/promo
FORCE_RUN=1 node docs-shots/shoot.mjs ui-mode      http://127.0.0.1:4830 ../../docs/images/ui-mode.png
node docs-shots/shoot.mjs pick-locator             http://127.0.0.1:4830 ../../docs/images/ui-mode-pick-locator.png

# HTML report + a failing trace: run a temporary typo'd-login test headless
# with the html reporter, video and trace on retain-on-failure, then
node docs-shots/shoot.mjs html-report  file:///…/index.html          ../../docs/images/html-report.png
node server.mjs &   # serves e2e/tapsmith-report/<trace>.zip at /t/<name>
node docs-shots/shoot.mjs trace-viewer 'http://127.0.0.1:4820/?trace=/t/<trace>.zip' ../../docs/images/trace-viewer.png
```

`ui-mode` runs the network-mocking test on both platforms, waits on the rail's
elapsed timer, re-runs any row that did not go green (a loaded machine makes
the Android agent time out), turns "Prepare device between runs" off so both
mirrors stay on the API Calls screen, and leaves it off for `pick-locator`.
The pick fractions target "Fetch Posts" on the Android mirror; recalibrate with
`docs-shots/canvas.mjs` (prints the canvas rect) if the screen layout changes.
Show the trace viewer's **Errors** tab, never Call — its SOURCE row shows the
real filesystem path.

## Rendering in GitHub Actions

`.github/workflows/promo-video.yml` does the device-free half of this pipeline
on a Linux runner: music bed, frame render (Chrome from `@puppeteer/browsers`,
picked up via `CHROME_PATH`), leak sweep, assembly, web encode, QC stills —
uploaded as the `promo-video` artifact. It runs on pull requests that touch
`tools/promo/`, and on demand from the Actions tab; ticking **publish**
also replaces the mp4 on the `promo-video` release and redeploys the website.
Releases publish automatically when needed: `release.yml` runs a publish
when `tools/promo/` (minus this README and `docs-shots/`) changed between the
previous release tag and the one being released, so a release whose video
inputs are unchanged costs no render. If that publish run ever fails, run the
workflow by hand with **publish** ticked.
Fonts are bundled (`assets/*.woff2`, incl. a variable Inter) so a runner render
matches a Mac render. Screen recordings and voiceover stay local + committed.

## Publishing the video to the website

The front page embeds `/promo.mp4`, fetched at build time by
`website/scripts/sync-promo.mjs` from the rolling `promo-video` GitHub
release (the mp4 is a derived artifact and stays out of git history). To
ship a new cut:

```bash
ffmpeg -i tapsmith-promo.mp4 -c:v libx264 -crf 24 -preset slow -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart promo.mp4
gh release upload promo-video promo.mp4 --clobber
gh workflow run deploy-website.yml
```

If the opening frames changed, also refresh the poster:
`ffmpeg -ss 2.6 -i tapsmith-promo.mp4 -frames:v 1 -q:v 3 website/public/promo-poster.jpg`
(the poster IS tracked in git — it's ~50KB).

## Files

| File | Purpose |
|---|---|
| `comp.html` | The video: scenes, animations, typed code, clips, patches, vector logo |
| `render-comp.mjs` | Frame renderer (`probe` \| `full <dsf> [from] [to]`) |
| `assemble.sh` | frames + VO + music -> `tapsmith-promo.mp4` (loudnorm -14 LUFS) |
| `record.mjs` / `record-ui.mjs` / `record-mcp.mjs` / `record-pick.mjs` / `record-multi.mjs` | Screen-recording choreography (CDP screencast) |
| `mcp-client.mjs` | Scripted MCP client ("claude-code") driving real tool calls for the MCP take |
| `api-error.test.ts.fixture` | The test the agent "writes" on camera — copy into e2e/tests before re-recording |
| `server.mjs` | Local trace-viewer server (no browser auto-open) |
| `build-clips.py` | Screencast frames -> retimed 30fps clips (UI: setup / streaming run / results) |
| `detect-paths.py` | Scans clip-ui.mp4 for absolute-path rows -> `patch-table.js` |
| `sweep-s3.py` | Post-render leak sweep: verifies every path row in S3 is patched |
| `probe-s3.mjs` | Renders QC stills of specific timeline moments |
| `synth-music.py` | Ambient music bed (numpy, deterministic) |
| `vo/lines.txt` | Voiceover script, one line per segment |
| `assets/` | Vector mark, Poppins/JetBrains Mono woff2, screenshots |
| `clip-ui.mp4` / `clip-trace.mp4` | Finished screen-recording clips |
| `clip-ui-session.mp4` | Full UI-mode session archive (source for future re-cuts) |
| `clip-mcp.mp4` / `clip-mcp-session.mp4` / `clip-mcp-full.mp4` | MCP-panel footage (crop cut, full-frame archive, full-window intro) |
| `clip-pick.mp4` / `clip-pick-session.mp4` | Locator-playground footage (scene cut + archive) |
| `clip-multi.mp4` / `clip-multi-session.mp4` | Two-device chat-test footage (scene cut + archive) |
| `probe-shot.mjs` | One-off screenshot of the running UI server (layout check before recording) |
| `demo-trace.zip` | Scrubbed failing trace driving the trace-viewer recording |

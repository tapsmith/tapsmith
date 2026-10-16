# The Tapsmith film (Oct 2026 revamp)

`tapsmith-promo.mp4`: 124 s, 1080p30, the existing ElevenLabs voiceover, an
original score and sound design generated in code, real UI-mode / trace
footage at 2× source resolution, and true motion blur.

Everything is a pure function of time. `index.html` loads the scenes, and
`window.seekFrame(t)` renders the exact frame for any `t`. Any frame can be
rendered by any worker, in any order.

## Pipeline

```bash
cd tools/promo
npm install                                  # puppeteer-core, gsap (easing only), sharp
python3 -m venv venv && ./venv/bin/pip install numpy scipy soundfile faster-whisper pillow

./venv/bin/python film/vo-words.py           # only if vo/*.mp3 changed: word timings -> vo-words.json
#   then regenerate vo-words.js (see the one-liner at the top of that file)
node film/render.mjs cues                    # sound cue sheet the scenes register -> film/cues.json
./venv/bin/python film/score.py              # -> film/music.wav + film/sfx.wav (~10 s)
node film/render.mjs full                    # 5 sub-frames x 2x supersampling, 6 workers -> film/frames/ (~15 min on an M1 Max)
film/assemble.sh                             # VO + ducked score + sfx, loudnorm -14 LUFS -> tapsmith-promo.mp4

# iteration
node film/render.mjs probe 18.2 52.5         # stills -> film/probe/p-<t>.jpg
node film/render.mjs strip 34 46 0.75        # contact sheet of a range
node film/render.mjs full --sub 1 --dsf 1 --out film/draft   # 2-minute draft of the whole film
film/assemble.sh audio                       # re-mix only
```

## Structure

| File | Role |
|---|---|
| `timeline.js` | Scene ranges, VO placement (`TL.VO`), `BEAT`, `W(seg, word)` = absolute time a VO word starts |
| `vo-words.js` | Whisper word timings per VO segment: picture cuts land on spoken words |
| `engine.js` | Keyframe tracks, camera rig (`E.cam`), `Footage` (frame-exact video and path patches), particles, WebGL backdrop and grain, chapter cards |
| `brand.js` | Logo mark (three pieces), the vector Checkout phone screen (iOS and Android) |
| `scenes/*.js` | One file per scene. Each registers its sound cues with `cue(t, kind)` |
| `score.py` | 120 BPM score (scene cuts sit on bar lines) plus one synthesized sound per cue |
| `render.mjs` | Puppeteer renderer: probes, strips, cue export, sub-frame accumulation (sharp) |
| `assemble.sh` | Mix (sidechain-ducks the music under the VO) and encode |
| `clips/*.mp4` | 3200×2000 rebuilds of the recordings, from the same concat lists as `../clip-*.mp4`, so `../patch-table.js` still lines up frame for frame |

## Facts worth knowing

- The UI-mode clip shows real absolute paths in the Call tab. `Footage` covers
  them using `../patch-table.js`, with a one-frame dilation on each side.
  The hi-res clip is frame-aligned with `clip-ui.mp4` (PSNR ≈ 50 dB per frame),
  so the table still applies. If you re-cut the clip, regenerate the table.
- The raw 3200×2000 frames live in `../.stash/` (git-ignored). `clips/*.txt`
  are the concat lists that rebuild `clips/*.mp4` from them.
- When the scene camera zooms past full-bleed, `E.clampFocus` keeps the
  window's edges out of frame.
- The `font:` shorthand resets `font-variant-ligatures`, so `index.html`
  disables ligatures with `!important`. Otherwise JetBrains Mono turns `=>` into an arrow.
- Emoji are avoided on purpose: CI renders on Linux.

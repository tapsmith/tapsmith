// ─── The film's clock ───
// Single source of truth for timing, shared by the picture (scenes/*.js) and the
// sound (score.py reads the cue sheet that render.mjs exports from the page).
// Scene boundaries sit on bar lines of the 120 BPM score (one bar = 2.0 s), and
// each voiceover segment starts a beat or two into its scene.
window.TL = {
  FPS: 30,
  DUR: 124.0,
  BPM: 120,
  BEAT: 18.0,            // the turn: "Tapsmith is the next step." resolves here
  VO: { '1': 1.0, '2a': 16.0, '2b': 18.75, '3': 34.5, '4': 46.5, '5': 58.5,
        '6': 70.5, '7': 84.5, '8': 98.5, '9': 117.0 },
  S: {
    problem: [0, 16],
    turn:    [16, 19.6],
    code:    [18.6, 34],
    ui:      [34, 46],
    pick:    [46, 58],
    multi:   [58, 70],
    mcp:     [70, 84],
    trace:   [84, 98],
    feat:    [98, 116],
    outro:   [116, 124],
  },
};

// Absolute time a VO word starts (or ends with which='e'). `nth` picks among repeats.
window.W = function (seg, word, which = 's', nth = 0) {
  const words = window.VOW[seg];
  let k = 0;
  for (const w of words) {
    if (w.w.toLowerCase().replace(/[^a-z0-9-]/g, '').startsWith(word.toLowerCase())) {
      if (k++ === nth) return window.TL.VO[seg] + w[which];
    }
  }
  throw new Error(`VO word not found: ${seg}/${word}`);
};

// Sound cues registered by scenes at build time (deterministic): {t, kind, ...}.
window.CUES = [];
window.cue = (t, kind, opts = {}) => { window.CUES.push({ t: +t.toFixed(4), kind, ...opts }); };

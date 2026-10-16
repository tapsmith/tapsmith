// ─── Scene 4 · UI mode (34–46 s) ───
// Real footage of UI mode running the network-mocking test. The camera
// directs attention beat by beat; the footage is speed-ramped to the VO.
(function () {
  const { h, kf, P, EP, op, tf, css } = E;
  const w3 = (w, n) => W('3', w, 's', n);
  const T = { this_: w3('this'), mode: w3('mode'), pick: w3('pick'), watch: w3('watch'), live: w3('live'), every: w3('every'),
    assertion: w3('assertion'), network: w3('network'), full: w3('full'), tree: w3('tree'), click: w3('click') };
  const [A, Bn] = TL.S.ui;
  // footage body coords (1600x1000) -> world
  const F = (x, y) => [x - 800, y - 480];
  // scene time -> clip time (speed ramps + one jump cut on the network beat)
  const MAP = [[A, 0.0], [T.pick - 0.5, 1.75], [T.pick + 0.6, 4.3], [T.network - 0.15, 11.3], [T.network - 0.15, 16.2], [T.full - 0.3, 19.6], [Bn, 23.6]];

  const S = { id: 'ui', range: [A - 0.6, Bn + 0.05] };
  let world, foot, chap, ring, callout, sweep;
  S.build = (root) => {
    ({ world } = E.viewport(root));
    world.style.transformStyle = 'preserve-3d';
    foot = new E.Footage(world, '../film/clips/ui.mp4', { patches: window.PATCH_RUNS });
    css(foot.el, { left: '-800px', top: '-520px' });
    ring = h('div', 'ring', world);
    callout = h('div', 'callout', world, '<span class="dot"></span>Full accessibility tree');
    sweep = h('div', '', world);
    css(sweep, { left: '-800px', top: '-520px', width: '1600px', height: '1040px', borderRadius: '14px', overflow: 'hidden', pointerEvents: 'none' });
    sweep.innerHTML = '<div style="position:absolute;top:-20%;bottom:-20%;width:380px;background:linear-gradient(90deg,transparent,rgba(255,220,200,0.35),transparent);transform:skewX(-18deg)"></div>';
    sweep.bar = sweep.firstChild;
    chap = new E.Chapter(root, '01 — RUN', 'UI Mode');
    S.ready = [foot.ready];
    cue(A - 0.3, 'whoosh', { dur: 0.9, gain: 0.9 });
    cue(A + 0.55, 'land', { gain: 0.7 });
    cue(T.pick - 0.35, 'whoosh', { dur: 0.5, gain: 0.4 });
    cue(T.pick + 0.25, 'click', { gain: 0.5 }); cue(T.pick + 0.55, 'click', { gain: 0.5 });
    cue(T.watch - 0.2, 'whoosh', { dur: 0.5, gain: 0.4 });
    cue(T.every - 0.2, 'whoosh', { dur: 0.5, gain: 0.4 });
    cue(T.network - 0.3, 'whoosh', { dur: 0.35, gain: 0.6 });
    cue(T.full - 0.3, 'whoosh', { dur: 0.6, gain: 0.45 });
    cue(T.click, 'pop', { gain: 0.5 });
  };
  S.update = (t) => {
    const ct = E.remap(t, MAP);
    const job = foot.seek(ct);
    // ── camera path: [time, focusX, focusY, scale] in footage coords ──
    const K = [
      [A - 0.6, 800, 500, 0.35], [A + 0.9, 800, 500, 1.2, 'expo.out'], [T.pick - 0.6, 800, 500, 1.22],
      [T.pick - 0.1, 250, 330, 2.05, 'power3.inOut'], [T.pick + 0.6, 260, 330, 2.1],
      [T.watch + 0.1, 1100, 420, 1.45, 'power3.inOut'], [T.every - 0.3, 1110, 410, 1.5],
      [T.every + 0.15, 520, 420, 1.85, 'power3.inOut'], [T.network - 0.45, 520, 560, 1.85],
      [T.network - 0.15, 760, 860, 1.7, 'whip'], [T.full - 0.6, 800, 880, 1.75],
      [T.full + 0.2, 800, 500, 1.2, 'power3.inOut'], [Bn, 800, 500, 1.2],
    ];
    const fx = kf(t, K.map(([a, x, , , e]) => [a, x, e])), fy = kf(t, K.map(([a, , y, , e]) => [a, y, e])), s = kf(t, K.map(([a, , , s2, e]) => [a, s2, e]));
    const [wx, wy] = F(...E.clampFocus(fx, fy, s));
    const ent = EP(t, A - 0.6, A + 0.9, 'expo.out');
    E.cam(world, { x: wx, y: wy, s, ry: (1 - ent) * -28, rx: (1 - ent) * 14, rz: (1 - ent) * 3 });
    op(world, P(t, A - 0.6, A - 0.2));
    // light sweep as the window lands
    const sw = P(t, A + 0.4, A + 1.3);
    tf(sweep.bar, `translateX(${-400 + 2400 * E.ease('power2.inOut')(sw)}px) skewX(-18deg)`);
    op(sweep, sw > 0 && sw < 1 ? 1 : 0);
    // the accessibility tree is one click away: ring the Hierarchy tab
    const [hx, hy] = F(538, 747);
    const rk = EP(t, T.full + 0.1, T.full + 0.5, 'back.out(2)');
    css(ring, { left: `${hx}px`, top: `${hy}px`, width: '88px', height: '36px' });
    tf(ring, `scale(${1.6 - 0.6 * rk})`); op(ring, rk);
    const ck = EP(t, T.tree - 0.1, T.tree + 0.4, 'expo.out');
    css(callout, { left: `${hx - 40}px`, top: `${hy - 92}px` });
    tf(callout, `translateY(${(1 - ck) * 20}px) scale(${0.9 + 0.1 * ck})`); op(callout, ck);
    chap.update(t, T.this_ + 0.2, T.pick - 0.4);
    return job;
  };
  SCENES.push(S);
})();

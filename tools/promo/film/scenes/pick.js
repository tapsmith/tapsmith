// ─── Scene 5 · Locator playground (46–58 s) ───
(function () {
  const { h, kf, P, EP, op, tf, css } = E;
  const w4 = (w, n) => W('4', w, 's', n);
  const T = { no: w4('no'), point: w4('point'), mirror: w4('mirror'), play: w4('playground'), robust: w4('robust'), access: w4('accessibility'),
    every: w4('every'), match: w4('match'), live: w4('live', 1) };
  const [A, Bn] = TL.S.pick;
  const F = (x, y) => [x - 800, y - 480];
  const MAP = [[A - 0.3, 0], [T.point - 0.5, 1.2], [T.play + 0.1, 5.95], [T.every - 0.6, 8.2], [Bn + 0.1, 11.2]];

  const S = { id: 'pick', range: [A - 0.3, Bn + 0.05] };
  let world, foot, chap, callout, svg, path, dot, flashEl;
  S.build = (root) => {
    ({ world } = E.viewport(root));
    world.style.transformStyle = 'preserve-3d';
    foot = new E.Footage(world, 'clips/pick.mp4');
    css(foot.el, { left: '-800px', top: '-520px' });
    callout = h('div', 'callout', world, '<span class="dot"></span>Role + name · accessibility-first');
    svg = h('div', '', world);
    css(svg, { left: '-800px', top: '-480px', width: '1600px', height: '1000px', pointerEvents: 'none' });
    svg.innerHTML = `<svg width="1600" height="1000" style="overflow:visible"><defs><filter id="pk-g"><feGaussianBlur stdDeviation="4"/></filter></defs>
      <path class="g" d="" fill="none" stroke="#fd8567" stroke-width="8" opacity="0.5" filter="url(#pk-g)"/>
      <path class="p" d="" fill="none" stroke="#fd8567" stroke-width="3.5" stroke-linecap="round"/>
      <circle class="d" r="7" fill="#ffd2c4"/></svg>`;
    path = [svg.querySelector('.g'), svg.querySelector('.p')];
    dot = svg.querySelector('.d');
    chap = new E.Chapter(root, '02 — LOCATE', 'Locator playground');
    S.ready = [foot.ready];
    cue(A - 0.15, 'swipe', { gain: 0.6 });
    cue(T.point - 0.4, 'whoosh', { dur: 0.6, gain: 0.5 });
    cue(T.play + 0.05, 'click', { gain: 0.55 });
    cue(T.play + 0.05, 'whoosh', { dur: 0.5, gain: 0.45 });
    cue(T.access, 'pop', { gain: 0.45 });
    cue(T.every - 0.5, 'whoosh', { dur: 0.6, gain: 0.45 });
    cue(T.match, 'zap', { gain: 0.55 });
  };
  S.update = (t) => {
    const job = foot.seek(E.remap(t, MAP));
    const K = [
      [A - 0.3, 800, 500, 1.2], [T.no + 0.4, 800, 500, 1.2], [T.no + 1.2, 700, 820, 1.7, 'power3.inOut'],
      [T.point - 0.45, 700, 820, 1.72], [T.point + 0.35, 1440, 340, 2.15, 'power3.inOut'], [T.play - 0.2, 1450, 300, 2.25],
      [T.play + 0.45, 640, 860, 1.9, 'power3.inOut'], [T.every - 0.75, 660, 860, 2.0],
      [T.every + 0.2, 800, 520, 1.2, 'power3.inOut'], [Bn, 800, 500, 1.2],
    ];
    const s = kf(t, K.map(([a, , , v, e]) => [a, v, e]));
    const fx = kf(t, K.map(([a, x, , , e]) => [a, x, e])), fy = kf(t, K.map(([a, , y, , e]) => [a, y, e]));
    const [wx, wy] = F(...E.clampFocus(fx, fy, s));
    E.cam(world, { x: wx, y: wy, s });
    // callout on the generated role+name locator
    const [cx, cy] = F(560, 800);
    const ck = EP(t, T.access - 0.05, T.access + 0.4, 'expo.out') * (1 - P(t, T.every - 0.6, T.every - 0.3));
    css(callout, { left: `${cx}px`, top: `${cy}px` });
    tf(callout, `translateY(${(1 - ck) * 16}px) scale(${(0.92 + 0.08 * ck) / 1.6})`);
    callout.style.transformOrigin = '0 100%';
    op(callout, ck);
    // every match highlighted live: a connector from the hovered locator to its element
    const a = [1010, 862], b = [1528, 268];
    const d = `M ${a[0]} ${a[1]} C ${a[0] + 300} ${a[1]}, ${b[0]} ${b[1] + 360}, ${b[0]} ${b[1] + 18}`;
    const pk = EP(t, T.match - 0.15, T.match + 0.45, 'power3.inOut');
    path.forEach((p) => { p.setAttribute('d', d); p.setAttribute('pathLength', '1'); p.setAttribute('stroke-dasharray', `${pk} 1`); });
    const L = path[1].getTotalLength ? path[1].getTotalLength() : 0;
    if (L) { const q = path[1].getPointAtLength(L * pk); dot.setAttribute('cx', q.x); dot.setAttribute('cy', q.y); }
    op(svg, pk > 0 ? 1 - P(t, Bn - 0.5, Bn - 0.1) : 0);
    op(dot, pk > 0 && pk < 1 ? 1 : 0);
    chap.update(t, T.no + 0.1, T.point - 0.2);
    op(world, P(t, A - 0.3, A));
    return job;
  };
  SCENES.push(S);
})();

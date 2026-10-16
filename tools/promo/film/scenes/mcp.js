// ─── Scene 7 · MCP server (70–84 s) ───
// UI mode's MCP panel detaches from the window and is wired to a Claude Code
// session; every tool call in the footage is a real one, mirrored by packets
// travelling the beam between agent and Tapsmith.
(function () {
  const { h, kf, P, EP, op, tf, css, hl, esc } = E;
  const w6 = (w, n) => W('6', w, 's', n);
  const T = { humans: w6('humans'), its: w6('its'), mcp: w6('mcp'), connect: w6('connect'), agent: w6('agent'), discovers: w6('discovers'),
    inspects: w6('inspects'), writes: w6('writes'), network: w6('network'), verifies: w6('verifies'), passes: w6('passes') };
  const [A, Bn] = TL.S.mcp;
  const F = (x, y) => [x - 800, y - 480];
  const MAP = [[A - 0.3, 0], [T.its, 1.0], [T.connect, 2.9], [T.connect + 0.5, 3.2], [T.discovers, 4.0], [T.inspects, 5.0], [T.writes - 0.2, 6.1],
    [T.verifies - 0.5, 6.9], [T.passes + 0.2, 11.1], [Bn + 0.1, 12.3]];
  const COL = { x0: 1296, y0: 52, w: 304, h: 948 };          // MCP panel + mirror column, body coords
  const K = 1.05;                                              // column scale once detached
  const COLX = 520, COLY = -14;                                  // detached column centre (world)
  const TERM = { x: -900, y: -400, w: 1110, h: 800 };
  const PROMPT = 'Add a test: when the posts API returns a 500, the app shows an error.';
  const CODE = [
    "await device.route('**/posts*', (route) =>",
    '  route.fulfill({ status: 500 }))',
    "await device.getByRole('button', { name: 'Fetch Posts' }).tap()",
    "await expect(device.getByText('Failed to fetch posts: HTTP 500')).toBeVisible()",
  ];

  const CSS = `
  #sc-mcp .term { position:absolute; overflow:hidden; font:400 25px 'JetBrains Mono',monospace; color:#e9e2da; }
  #sc-mcp .term .tb { height:58px; display:flex; align-items:center; gap:10px; padding:0 24px; border-bottom:1px solid var(--line); font:500 19px 'Inter'; color:var(--sand); }
  #sc-mcp .term .tb i { width:13px; height:13px; border-radius:50%; display:block; }
  #sc-mcp .tbody { padding:30px 36px; line-height:1.55; white-space:normal; }
  #sc-mcp .ps { color:var(--coral); margin-right:14px; }
  #sc-mcp .step { margin-top:22px; } #sc-mcp .step .b { display:inline-block; width:14px; height:14px; border-radius:50%; background:var(--coral); margin-right:16px; vertical-align:0; box-shadow:0 0 12px var(--coral); }
  #sc-mcp .tool { color:#93b9ff; } #sc-mcp .dim { color:#8a8075; }
  #sc-mcp .res { padding-left:32px; color:#8a8075; } #sc-mcp .res .el { display:inline-block; width:13px; height:14px; border-left:2px solid #6d655c; border-bottom:2px solid #6d655c; margin-right:14px; vertical-align:2px; }
  #sc-mcp .ok { color:var(--green); }
  #sc-mcp .code { margin:12px 0 0 32px; padding:16px 22px; border-radius:12px; background:rgba(0,0,0,0.25); border:1px solid var(--line); font-size:19.5px; line-height:1.65; position:relative; } #sc-mcp .code .cl { white-space:pre; }
  #sc-mcp .code .mk { position:absolute; left:10px; right:10px; border-radius:6px; background:rgba(253,133,103,0.16); box-shadow:inset 3px 0 0 var(--coral); }
  #sc-mcp .spin { display:inline-block; width:18px; height:18px; border-radius:50%; border:3px solid #3a322b; border-top-color:var(--coral); margin-left:14px; vertical-align:-3px; }
  #sc-mcp .colwrap { position:absolute; left:-800px; top:-520px; width:1600px; height:1040px; transform-origin:${COL.x0 + COL.w / 2}px ${40 + COL.y0 + COL.h / 2}px; }
  #sc-mcp .colwrap .win { position:absolute; left:0; top:0; }
  #sc-mcp .beam { position:absolute; pointer-events:none; }
  #sc-mcp .mcp-pill { position:absolute; padding:8px 18px; border-radius:20px; font:700 18px 'JetBrains Mono',monospace; letter-spacing:0.14em; color:#1a120d; background:var(--coral);
     box-shadow:0 0 30px rgba(253,133,103,0.7); white-space:nowrap; }
  `;
  h('style', '', document.head, CSS);

  const S = { id: 'mcp', range: [A - 0.3, Bn + 0.05] };
  let world, foot, colwrap, term, els = {}, chap;
  S.build = (root) => {
    ({ world } = E.viewport(root));
    world.style.transformStyle = 'preserve-3d';
    colwrap = h('div', 'colwrap', world);
    foot = new E.Footage(colwrap, 'clips/mcp.mp4');
    // beam between terminal and column
    els.beam = h('div', 'beam', world);
    css(els.beam, { left: '0px', top: '0px' });
    els.beam.innerHTML = `<svg width="10" height="10" style="overflow:visible"><defs><filter id="mc-g"><feGaussianBlur stdDeviation="6"/></filter></defs>
      <path class="g" fill="none" stroke="#fd8567" stroke-width="12" opacity="0.4" filter="url(#mc-g)"/>
      <path class="p" fill="none" stroke="#fd8567" stroke-width="3"/>
      ${[0, 1, 2, 3, 4, 5].map((i) => `<circle class="pk${i}" r="7" fill="#ffd2c4"/>`).join('')}</svg>`;
    els.bp = [els.beam.querySelector('.g'), els.beam.querySelector('.p')];
    els.pk = [0, 1, 2, 3, 4, 5].map((i) => els.beam.querySelector('.pk' + i));
    els.pill = h('div', 'mcp-pill', world, 'MCP');
    // Claude Code terminal
    term = h('div', 'panel term', world);
    css(term, { left: `${TERM.x}px`, top: `${TERM.y}px`, width: `${TERM.w}px`, height: `${TERM.h}px` });
    term.innerHTML = `<div class="tb"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span style="margin-left:14px">Claude Code — acme-mobile</span></div>
      <div class="tbody"><div><span class="ps">❯</span><span class="typed"></span></div>
      <div class="step s1"><span class="b"></span><span class="tool">tapsmith_list_tests</span> <span class="dim">()</span></div>
      <div class="res r1"><span class="el"></span>Projects: authentication, default, authenticated</div>
      <div class="step s2"><span class="b"></span><span class="tool">tapsmith_snapshot</span> <span class="dim">()</span></div>
      <div class="res r2"><span class="el"></span>3 elements, 28 locators · getByRole('button', { name: 'Fetch Posts' }) <span class="ok">✓ unique</span></div>
      <div class="step s3"><span class="b"></span><span class="tool">Write</span> <span class="dim">(e2e/tests/api-error.test.ts)</span></div>
      <div class="code c3"><div class="mk"></div>${CODE.map((l) => `<div class="cl">${hl(l)}</div>`).join('')}</div>
      <div class="step s4"><span class="b"></span><span class="tool">tapsmith_run_tests</span> <span class="dim">(files: ["api-error.test.ts"])</span><span class="spin"></span></div>
      <div class="res r4"><span class="el"></span><span class="ok">✓ 1 passed</span> <span class="dim">(5.6s)</span></div></div>`;
    const q = (c) => term.querySelector(c);
    Object.assign(els, { typed: q('.typed'), s1: q('.s1'), r1: q('.r1'), s2: q('.s2'), r2: q('.r2'), s3: q('.s3'), c3: q('.c3'), s4: q('.s4'), r4: q('.r4'), spin: q('.spin'), mk: q('.mk') });
    els.cls = [...term.querySelectorAll('.code .cl')];
    chap = new E.Chapter(root, '04 — AUTOMATE', 'MCP server');
    S.ready = [foot.ready];
    cue(A - 0.15, 'swipe', { gain: 0.6 });
    cue(T.humans - 0.6, 'whoosh', { dur: 0.6, gain: 0.5 });
    cue(T.its - 0.1, 'whoosh', { dur: 0.9, gain: 0.8 });
    cue(T.mcp + 0.3, 'land', { gain: 0.5 });
    cue(T.connect + 0.1, 'zap', { gain: 0.7 });
    for (let i = 0; i < 24; i++) cue(T.connect + 0.55 + i * 0.045, 'key', { gain: 0.2 });
    [T.discovers, T.inspects, T.writes, T.verifies].forEach((t) => cue(t, 'blip', { gain: 0.55 }));
    cue(T.passes + 0.15, 'success', { gain: 0.8 });
  };
  // packets: [time, direction (+1 agent→tapsmith, -1 back)]
  const PK = () => [[T.discovers - 0.35, 1], [T.discovers + 0.25, -1], [T.inspects - 0.35, 1], [T.inspects + 0.5, -1], [T.verifies - 0.35, 1], [T.passes + 0.1, -1]];
  S.update = (t) => {
    const job = foot.seek(E.remap(t, MAP));
    // ── detach: full window → MCP column ──
    const dk = EP(t, T.its - 0.2, T.its + 0.9, 'expo.inOut');
    const cx0 = COL.x0 + COL.w / 2 - 800, cy0 = 40 + COL.y0 + COL.h / 2 - 520;    // column centre in world at rest
    tf(colwrap, `translate(${(COLX - cx0) * dk}px, ${(COLY - cy0) * dk}px) scale(${1 + (K - 1) * dk})`);
    foot.el.style.clipPath = `inset(${(40 + COL.y0) * dk}px 0 ${0}px ${COL.x0 * dk}px round ${14 + 6 * dk}px)`;
    foot.el.style.boxShadow = dk > 0.5 ? '0 50px 140px rgba(0,0,0,0.7)' : '';
    // ── terminal ──
    const tk = EP(t, T.mcp - 0.2, T.mcp + 0.6, 'expo.out');
    tf(term, `translateX(${(1 - tk) * -160}px) rotateY(${(1 - tk) * 20}deg)`);
    op(term, tk);
    const n = Math.floor(PROMPT.length * P(t, T.connect + 0.5, T.connect + 1.6));
    els.typed.innerHTML = esc(PROMPT.slice(0, n)) + (t < T.discovers - 0.2 ? E.caret(t) : '');
    const rev = (el, at) => { const k = EP(t, at, at + 0.35, 'expo.out'); op(el, k); tf(el, `translateY(${(1 - k) * 10}px)`); E.show(el, t >= at - 0.01); };
    rev(els.s1, T.discovers); rev(els.r1, T.discovers + 0.45);
    rev(els.s2, T.inspects); rev(els.r2, T.inspects + 0.7);
    rev(els.s3, T.writes); rev(els.c3, T.writes + 0.15);
    els.cls.forEach((c, i) => op(c, P(t, T.writes + 0.3 + i * 0.28, T.writes + 0.45 + i * 0.28)));
    // highlight the network mock on "network mock included"
    const mk = EP(t, T.network - 0.1, T.network + 0.3, 'expo.out') * (1 - P(t, T.verifies - 0.3, T.verifies));
    css(els.mk, { top: '14px', height: '62px', width: `${100 * mk}%`, right: 'auto' });
    op(els.mk, mk);
    rev(els.s4, T.verifies); rev(els.r4, T.passes + 0.15);
    E.show(els.spin, t >= T.verifies && t < T.passes + 0.15);
    tf(els.spin, `rotate(${(t * 600) % 360}deg)`);
    // ── beam: terminal right edge → column left edge ──
    const ax = TERM.x + TERM.w, ay = -40, bx = COLX - (COL.w * K) / 2, by = -260;
    const d = `M ${ax} ${ay} C ${ax + 90} ${ay}, ${bx - 90} ${by}, ${bx} ${by}`;
    const bk = EP(t, T.connect, T.connect + 0.45, 'power3.inOut');
    els.bp.forEach((p) => { p.setAttribute('d', d); p.setAttribute('pathLength', '1'); p.setAttribute('stroke-dasharray', `${bk} 1`); });
    const L = els.bp[1].getTotalLength();
    PK().forEach(([pt, dir], i) => {
      const k = P(t, pt, pt + 0.4);
      const u = dir > 0 ? k : 1 - k;
      const q = els.bp[1].getPointAtLength(L * E.ease('power1.inOut')(u));
      els.pk[i].setAttribute('cx', q.x); els.pk[i].setAttribute('cy', q.y);
      op(els.pk[i], k > 0 && k < 1 ? 1 : 0);
    });
    op(els.beam, bk > 0 ? 1 : 0);
    const mid = els.bp[1].getPointAtLength(L * 0.5);
    tf(els.pill, `translate(${mid.x - 36}px, ${mid.y - 60}px) scale(${EP(t, T.connect + 0.25, T.connect + 0.6, 'back.out(2)')})`);
    op(els.pill, P(t, T.connect + 0.25, T.connect + 0.4));
    // ── camera ──
    const K2 = [
      [A - 0.3, 800, 500, 1.2], [T.humans - 0.9, 800, 500, 1.2], [T.humans - 0.1, 1420, 240, 2.4, 'power3.inOut'], [T.its - 0.25, 1430, 250, 2.45],
    ];
    let cam;
    if (t < T.its - 0.25) {
      const s = kf(t, K2.map(([a, , , v, e]) => [a, v, e]));
      const fx = kf(t, K2.map(([a, x, , , e]) => [a, x, e])), fy = kf(t, K2.map(([a, , y, , e]) => [a, y, e]));
      const [wx, wy] = F(...E.clampFocus(fx, fy, s));
      cam = { x: wx, y: wy, s };
    } else {
      // pull back to the two-up as the column detaches
      const k = EP(t, T.its - 0.25, T.its + 0.9, 'expo.inOut');
      const [wx, wy] = F(1430, 250);
      cam = { x: E.lerp(wx, -40, k) + kf(t, [[T.its + 0.9, 0], [T.discovers, -20], [T.passes, 30, 'none']]), y: E.lerp(wy, 0, k), s: E.lerp(2.45, 0.98, k) * kf(t, [[T.its + 0.9, 1], [Bn, 1.06, 'none']]),
        ry: kf(t, [[T.its, 0], [T.its + 1.2, -5], [Bn, -2]]), rx: kf(t, [[T.its, 0], [T.its + 1.2, 3], [Bn, 1]]) };
    }
    E.cam(world, cam);
    chap.update(t, T.mcp - 0.3, T.connect + 0.5);
    op(world, P(t, A - 0.3, A));
    return job;
  };
  SCENES.push(S);
})();

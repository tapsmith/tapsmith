// ─── Scene 6 · Multi-device (58–70 s) ───
// Two simulators, one test. A code card declares the pair; then the camera
// sits on the two live panes as a message arcs from Alice's device to Bob's.
(function () {
  const { h, kf, P, EP, op, tf, css, hl } = E;
  const w5 = (w, n) => W('5', w, 's', n);
  const T = { need: w5('need'), declare: w5('declare'), devices: w5('devices'), drives: w5('drives'), alice: w5('alice'), bob: w5('bob'),
    every: w5('every'), side: w5('side') };
  const [A, Bn] = TL.S.multi;
  const F = (x, y) => [x - 800, y - 480];
  // scene -> clip; hard jumps skip the trace panes' "No screenshot" flicker frames
  const MAP = [[A - 0.3, 0.0], [T.declare - 0.5, 1.0], [T.drives - 0.2, 3.6], [T.drives + 0.75, 4.85], [T.drives + 0.75, 5.18],
    [T.alice, 5.8], [T.bob, 6.05], [T.bob + 0.45, 6.13], [T.bob + 0.45, 6.32], [T.every - 0.1, 7.35], [Bn + 0.1, 13.0]];
  // message positions in footage body coords (alice pane → bob pane)
  const MSG_A = [740, 539], MSG_B = [1082, 421];

  const S = { id: 'multi', range: [A - 0.3, Bn + 0.05] };
  let world, foot, chap, card, arc, bubble, glowA, glowB, tags;
  S.build = (root) => {
    ({ world } = E.viewport(root));
    world.style.transformStyle = 'preserve-3d';
    foot = new E.Footage(world, 'clips/multi.mp4');
    css(foot.el, { left: '-800px', top: '-520px' });
    // overlay svg for the message arc
    arc = h('div', '', world);
    css(arc, { left: '-800px', top: '-480px', width: '1600px', height: '1000px', pointerEvents: 'none' });
    arc.innerHTML = `<svg width="1600" height="1000" style="overflow:visible"><defs><filter id="mu-g"><feGaussianBlur stdDeviation="5"/></filter></defs>
      <path class="g" fill="none" stroke="#fd8567" stroke-width="10" opacity="0.45" filter="url(#mu-g)"/>
      <path class="p" fill="none" stroke="#fd8567" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 0"/></svg>`;
    arc.paths = [arc.querySelector('.g'), arc.querySelector('.p')];
    bubble = h('div', '', world, 'Hi Bob');
    css(bubble, { padding: '10px 18px', borderRadius: '18px 18px 18px 4px', background: '#fd8567', color: '#1a120d', font: "700 22px 'Inter'", whiteSpace: 'nowrap',
      boxShadow: '0 10px 40px rgba(253,133,103,0.6)' });
    glowA = h('div', 'ring', world); glowB = h('div', 'ring', world);
    tags = ['alice', 'bob'].map((n, i) => h('div', 'callout', world, `<span class="dot" style="${i ? 'background:#8fb4ff;box-shadow:0 0 14px #8fb4ff' : ''}"></span>${n}`));
    // the declaration card (screen space, over the defocused footage)
    card = h('div', 'panel', root);
    css(card, { position: 'absolute', left: '50%', top: '50%', width: '1400px', padding: '40px 48px', font: "400 30px 'JetBrains Mono',monospace", lineHeight: '1.75', whiteSpace: 'pre', color: '#e9e2da' });
    card.innerHTML = `<div style="font:600 17px Inter;letter-spacing:.16em;color:#fd8567;margin-bottom:14px">TAPSMITH.CONFIG.TS · CHAT.TEST.TS</div>` +
      `<div class="l1">${hl("use: { devices: [{ name: 'alice' }, { name: 'bob' }] }")}</div><div class="l2" style="margin-top:12px">${hl("test('alice messages bob', async ({ devices: [alice, bob] }) => {")}</div>` +
      `<div class="u1" style="position:absolute;height:4px;border-radius:2px;background:#fd8567;box-shadow:0 0 14px #fd8567;transform-origin:0 50%"></div>` +
      `<div class="u2" style="position:absolute;height:4px;border-radius:2px;background:#fd8567;box-shadow:0 0 14px #fd8567;transform-origin:0 50%"></div>`;
    card.u = [card.querySelector('.u1'), card.querySelector('.u2')];
    chap = new E.Chapter(root, '03 — PAIR', 'Multi-device');
    S.ready = [foot.ready];
    cue(A - 0.15, 'swipe', { gain: 0.6 });
    cue(T.declare - 0.4, 'whoosh', { dur: 0.5, gain: 0.5 });
    cue(T.devices, 'pop', { gain: 0.5 });
    cue(T.drives - 0.35, 'whoosh', { dur: 0.6, gain: 0.6 });
    cue(T.alice + 0.05, 'send', { gain: 0.7 });
    cue(T.bob + 0.05, 'pop', { gain: 0.6 });
    cue(T.every - 0.3, 'whoosh', { dur: 0.6, gain: 0.45 });
  };
  S.update = (t) => {
    const job = foot.seek(E.remap(t, MAP));
    // card: in on "Declare", out as the devices start acting
    const cin = EP(t, T.need + 0.9, T.need + 1.6, 'expo.out'), cout = EP(t, T.drives - 0.5, T.drives, 'power3.in');
    tf(card, `translate(-50%, -50%) translateY(${(1 - cin) * 80 - cout * 40}px) scale(${(0.94 + 0.06 * cin) * (1 + 0.25 * cout)})`);
    op(card, cin * (1 - cout));
    // underline "devices" in both lines on the word
    const uk = EP(t, T.devices - 0.05, T.devices + 0.35, 'expo.out');
    const CWm = 18.0;   // 30px JetBrains Mono advance
    [[1, 'use: { '.length, 7], [2, "test('alice messages bob', async ({ ".length, 7]].forEach(([line, col, len], i) => {
      const u = card.u[i];
      css(u, { left: `${48 + col * CWm}px`, top: `${(line === 1 ? 108 : 173)}px`, width: `${len * CWm}px` });
      tf(u, `scaleX(${EP(t, T.devices - 0.05 + i * 0.12, T.devices + 0.35 + i * 0.12, 'expo.out')})`);
    });
    // footage defocus while the card is up
    const dof = cin * (1 - cout);
    foot.el.style.filter = dof > 0.01 ? `blur(${(10 * dof).toFixed(2)}px) brightness(${1 - 0.45 * dof})` : 'none';
    // camera
    const K = [
      [A - 0.3, 800, 500, 1.2], [T.need + 0.8, 800, 500, 1.2], [T.need + 1.6, 820, 500, 1.35, 'power2.inOut'],
      [T.drives - 0.4, 840, 500, 1.35], [T.drives + 0.4, 980, 480, 2.1, 'power3.inOut'], [T.every - 0.4, 990, 470, 2.2],
      [T.every + 0.4, 520, 480, 1.7, 'power3.inOut'], [T.side + 0.1, 560, 500, 1.72], [Bn - 0.4, 800, 500, 1.2, 'power3.inOut'], [Bn, 800, 500, 1.2],
    ];
    const s = kf(t, K.map(([a, , , v, e]) => [a, v, e]));
    const fx = kf(t, K.map(([a, x, , , e]) => [a, x, e])), fy = kf(t, K.map(([a, , y, , e]) => [a, y, e]));
    const [wx, wy] = F(...E.clampFocus(fx, fy, s));
    E.cam(world, { x: wx, y: wy, s });
    // device name tags over the two panes while both act
    const tk = EP(t, T.drives + 0.2, T.drives + 0.7, 'expo.out') * (1 - P(t, T.every - 0.5, T.every - 0.2));
    [[700, 250], [1020, 250]].forEach(([x, y], i) => {
      const [X, Y] = F(x, y);
      css(tags[i], { left: `${X}px`, top: `${Y}px` });
      tf(tags[i], `scale(${0.5}) translateY(${(1 - tk) * 30}px)`); tags[i].style.transformOrigin = '0 0';
      op(tags[i], tk);
    });
    // the message arc: alice -> bob
    const [ax, ay] = MSG_A, [bx, by] = MSG_B;
    const d = `M ${ax + 40} ${ay - 6} C ${ax + 120} ${ay - 330}, ${bx - 80} ${by - 230}, ${bx + 10} ${by - 10}`;
    const ak = EP(t, T.alice, T.bob + 0.05, 'power2.inOut');
    arc.paths.forEach((p) => { p.setAttribute('d', d); p.setAttribute('pathLength', '1'); p.setAttribute('stroke-dasharray', `${ak} 1`); });
    op(arc, ak > 0 ? 1 - P(t, T.bob + 0.5, T.bob + 0.9) : 0);
    const L = arc.paths[1].getTotalLength();
    const q = arc.paths[1].getPointAtLength(L * ak);
    const [qx, qy] = F(q.x, q.y);
    tf(bubble, `translate(${qx - 40}px, ${qy - 58}px) scale(${0.55 * (0.8 + 0.2 * Math.sin(Math.PI * ak))})`);
    bubble.style.transformOrigin = '0 100%';
    op(bubble, ak > 0 && ak < 1 ? 1 : 0);
    // glow rings where the message leaves and lands
    [[glowA, MSG_A, T.alice], [glowB, MSG_B, T.bob]].forEach(([g, [x, y], at]) => {
      const [X, Y] = F(x - 8, y - 14);
      const gk = EP(t, at, at + 0.35, 'back.out(2)') * (1 - P(t, at + 0.9, at + 1.2));
      css(g, { left: `${X}px`, top: `${Y}px`, width: '120px', height: '28px', borderRadius: '8px', borderWidth: '2px' });
      tf(g, `scale(${1.4 - 0.4 * gk})`); op(g, gk);
    });
    chap.update(t, T.need + 0.05, T.drives - 0.6);
    op(world, P(t, A - 0.3, A));
    return job;
  };
  SCENES.push(S);
})();

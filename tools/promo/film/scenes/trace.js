// ─── Scene 8 · Trace viewer (84–98 s) ───
// A CI job fails; its trace artifact is downloaded, flies into a terminal,
// and the trace viewer bursts out of `show-trace` — then real footage of
// time-travelling the failed gestures test down to the exact assertion.
(function () {
  const { h, kf, P, EP, op, tf, css, esc } = E;
  const w7 = (w, n) => W('7', w, 's', n);
  const T = { fails: w7('fails'), ci: w7('ci'), dont: w7('dont'), download: w7('download'), open: w7('open'), viewer: w7('viewer'),
    time: w7('time'), screenshots: w7('screenshots'), actions: w7('actions'), network: w7('network'), exactly: w7('exactly'), broke: w7('broke') };
  const [A, Bn] = TL.S.trace;
  const F = (x, y) => [x - 800, y - 480];
  const VIN = T.viewer - 0.15;                              // viewer bursts out of the terminal
  const MAP = [[VIN, 0.0], [T.time - 0.1, 0.5], [T.time - 0.1, 6.0], [T.actions - 0.25, 8.3], [T.actions - 0.25, 0.9], [T.network + 0.4, 3.7],
    [T.network + 0.4, 4.45], [T.broke + 0.6, 6.0], [T.broke + 0.6, 9.1], [Bn + 0.1, 10.6]];
  const STEPS = [['Set up job', '2s'], ['Boot iOS simulator', '41s'], ['Build app', '3m 12s'], ['npx tapsmith test', '1m 58s']];

  const CSS = `
  #sc-trace .ci { position:absolute; width:1180px; font-family:'Inter'; color:var(--cream); overflow:hidden; }
  #sc-trace .ci .hd { display:flex; align-items:center; gap:16px; padding:24px 34px; border-bottom:1px solid var(--line); font:600 26px 'Inter'; }
  #sc-trace .ci .hd .st { width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; font:800 17px 'Inter'; color:#fff; }
  #sc-trace .ci .hd small { font:500 20px 'JetBrains Mono',monospace; color:var(--muted); margin-left:auto; }
  #sc-trace .ci .row { display:flex; align-items:center; gap:18px; padding:15px 34px; font:500 24px 'Inter'; color:#cfc6bb; }
  #sc-trace .ci .row .ic { width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; font:800 14px 'Inter'; color:#0d0a08; flex:none; }
  #sc-trace .ci .row .tm { margin-left:auto; font:400 20px 'JetBrains Mono',monospace; color:var(--muted); }
  #sc-trace .ci .err { margin:4px 34px 0 78px; padding:16px 20px; border-radius:12px; background:rgba(255,90,82,0.08); border:1px solid rgba(255,90,82,0.35);
     font:400 20px 'JetBrains Mono',monospace; color:#ff8a82; white-space:pre; overflow:hidden; }
  #sc-trace .ci .art { display:flex; align-items:center; gap:18px; margin-top:20px; padding:22px 34px; border-top:1px solid var(--line); font:500 22px 'Inter'; color:var(--muted); }
  #sc-trace .ci .art .zip { font:500 22px 'JetBrains Mono',monospace; color:var(--cream); }
  #sc-trace .ci .dl { margin-left:auto; padding:11px 26px; border-radius:24px; font:700 20px 'Inter'; color:var(--cream); border:1.5px solid rgba(255,236,218,0.25); position:relative; }
  #sc-trace .file { position:absolute; width:120px; height:150px; border-radius:14px; background:linear-gradient(160deg,#ffb199,#fd8567); box-shadow:0 20px 60px rgba(253,133,103,0.5);
     display:flex; align-items:flex-end; justify-content:center; padding-bottom:18px; font:700 20px 'JetBrains Mono',monospace; color:#2a160e; }
  #sc-trace .file::before { content:''; position:absolute; right:0; top:0; width:34px; height:34px; background:rgba(255,255,255,0.45); border-bottom-left-radius:10px; }
  #sc-trace .file .zz { position:absolute; left:50%; top:22px; width:14px; height:54px; transform:translateX(-50%);
     background:repeating-linear-gradient(180deg, #2a160e 0 6px, transparent 6px 12px); opacity:0.6; }
  #sc-trace .tm2 { position:absolute; width:1040px; padding:30px 36px; font:400 30px 'JetBrains Mono',monospace; white-space:pre; color:#e9e2da; }
  #sc-trace .tm2 .dim { color:var(--muted); }
  `;
  h('style', '', document.head, CSS);

  const S = { id: 'trace', range: [A - 0.3, Bn + 0.3] };
  let world, foot, chap, ci, file, term, els = {};
  S.build = (root) => {
    ({ world } = E.viewport(root));
    world.style.transformStyle = 'preserve-3d';
    ci = h('div', 'panel ci', world);
    ci.innerHTML = `<div class="hd"><span class="st">●</span>e2e-ios <small>run #4127 · main</small></div>` +
      STEPS.map(([n, tm], i) => `<div class="row r${i}"><span class="ic"></span><span>${n}</span><span class="tm">${tm}</span></div>`).join('') +
      `<div class="err">✕ gestures.test.ts › double tap registers double tap gesture\n  Expected "Double tap", received "Single tap"</div>` +
      `<div class="art">Artifact <span class="zip">trace.zip</span><span>· 4.2 MB</span><span class="dl">↓ Download</span></div>`;
    els.st = ci.querySelector('.st'); els.rows = [...ci.querySelectorAll('.row')]; els.err = ci.querySelector('.err'); els.dl = ci.querySelector('.dl');
    els.ics = els.rows.map((r) => r.querySelector('.ic'));
    file = h('div', 'file', world, '<span class="zz"></span>.zip');
    term = h('div', 'panel tm2', world);
    foot = new E.Footage(world, 'clips/trace.mp4', { chrome: 'localhost:4831 · Tapsmith Trace Viewer' });
    css(foot.el, { left: '-800px', top: '-520px' });
    els.ring = h('div', 'ring', world);
    els.call = h('div', 'callout', world, '<span class="dot" style="background:#ff5a52;box-shadow:0 0 14px #ff5a52"></span>Expected “Double tap” · got “Single tap”');
    chap = new E.Chapter(root, '05 — DEBUG', 'Trace viewer');
    S.ready = [foot.ready];
    cue(A - 0.2, 'whoosh', { dur: 0.8, gain: 0.7 });
    cue(T.fails + 0.05, 'fail', { gain: 0.9 });
    cue(T.download, 'click', { gain: 0.6 });
    cue(T.download + 0.1, 'whoosh', { dur: 0.6, gain: 0.55 });
    for (let i = 0; i < 18; i++) cue(T.open - 0.5 + i * 0.045, 'key', { gain: 0.22 });
    cue(VIN, 'burst', { gain: 0.9 });
    cue(T.time - 0.2, 'rewind', { gain: 0.7 });
    cue(T.actions - 0.3, 'whoosh', { dur: 0.4, gain: 0.45 });
    cue(T.network + 0.35, 'whoosh', { dur: 0.4, gain: 0.45 });
    cue(T.broke - 0.05, 'hit', { gain: 0.7 });
  };
  S.update = (t) => {
    // ── CI card ──
    const ck = EP(t, A - 0.2, A + 0.6, 'expo.out');
    const cout = EP(t, T.open - 0.6, T.open, 'power3.in');
    const failed = t >= T.fails;
    els.rows.forEach((r, i) => {
      const at = A + 0.25 + i * 0.22;
      op(r, P(t, at, at + 0.2));
      const ic = els.ics[i];
      const last = i === STEPS.length - 1;
      const done = !last ? t >= at + 0.15 : failed;
      css(ic, { background: done ? (last ? '#ff5a52' : '#5fd38d') : 'transparent', border: done ? 'none' : '2.5px solid #5d544c' });
      ic.textContent = done ? (last ? '✕' : '✓') : '';
      if (last && !done) { ic.style.borderTopColor = '#fd8567'; tf(ic, `rotate(${(t * 500) % 360}deg)`); } else tf(ic, 'none');
    });
    css(els.st, { background: failed ? '#ff5a52' : '#d9a441' });
    els.st.textContent = failed ? '✕' : '●';
    const ek = EP(t, T.fails + 0.05, T.fails + 0.45, 'expo.out');
    css(els.err, { maxHeight: `${110 * ek}px`, opacity: ek, marginTop: `${4 * ek}px`, paddingTop: `${16 * ek}px`, paddingBottom: `${16 * ek}px` });
    const shake = t >= T.fails && t < T.fails + 0.4 ? Math.sin((t - T.fails) * 70) * 12 * (1 - (t - T.fails) / 0.4) : 0;
    tf(ci, `translate3d(${-590 + shake - 300 * cout}px, ${-420 + (1 - ck) * 120}px, ${-300 * cout}px) rotateY(${12 * cout}deg)`);
    op(ci, ck * (1 - cout));
    ci.style.boxShadow = failed ? `0 50px 140px rgba(0,0,0,0.6), 0 0 ${60 * Math.exp(-(t - T.fails) * 2)}px rgba(255,90,82,0.6)` : '';
    // download pill lights up; the artifact flies to the terminal
    const dk = P(t, T.download - 0.1, T.download + 0.1);
    css(els.dl, { background: dk > 0 ? `rgba(253,133,103,${0.9 * dk})` : 'transparent', color: dk > 0.5 ? '#1a120d' : '' });
    tf(els.dl, `scale(${1 - 0.08 * Math.sin(Math.PI * P(t, T.download, T.download + 0.2))})`);
    const fk = EP(t, T.download + 0.1, T.open - 0.05, 'power2.inOut');
    const fx0 = 430, fy0 = -10, fx1 = -440, fy1 = 150;
    tf(file, `translate(${E.lerp(fx0, fx1, fk)}px, ${E.lerp(fy0, fy1, fk) - Math.sin(Math.PI * fk) * 260}px) rotate(${-25 * Math.sin(Math.PI * fk) + 8 * (1 - fk)}deg) scale(${(0.4 + 0.6 * EP(t, T.download + 0.1, T.download + 0.4, 'back.out(2)')) * (1 - 0.6 * P(t, T.open - 0.15, T.open + 0.05))})`);
    op(file, P(t, T.download + 0.1, T.download + 0.2) * (1 - P(t, T.open - 0.1, T.open + 0.05)));
    // terminal with show-trace
    const tk = EP(t, T.download + 0.3, T.download + 0.9, 'expo.out');
    const CMD = ' npx tapsmith show-trace trace.zip';
    const n = Math.floor(CMD.length * P(t, T.open - 0.5, T.open + 0.3));
    const opened = t >= T.viewer - 0.4;
    term.innerHTML = `<span class="c-ps">$</span>${esc(CMD.slice(0, n))}${!opened ? E.caret(t) : ''}\n${opened ? '<span class="dim">  Trace viewer → http://localhost:4831</span>' : ' '}`;
    const vk = EP(t, VIN, VIN + 0.7, 'expo.inOut');
    tf(term, `translate3d(${-520}px, ${150 + (1 - tk) * 100}px, ${vk * 400}px)`);
    op(term, tk * (1 - P(t, VIN + 0.05, VIN + 0.35)));
    // ── viewer bursts out of the terminal ──
    const job = t >= VIN - 0.05 ? foot.seek(E.remap(t, MAP)) : null;
    tf(foot.el, `translate(${(1 - vk) * 0}px, ${(1 - vk) * 250}px) scale(${0.25 + 0.75 * vk})`);
    foot.el.style.transformOrigin = '50% 50%';
    op(foot.el, P(t, VIN - 0.05, VIN + 0.15));
    // ── what broke: ring the failing assertion + callout ──
    const [rx, ry] = F(1032, 252);
    const rk = EP(t, T.exactly - 0.05, T.exactly + 0.3, 'back.out(2)') * (1 - P(t, Bn - 0.6, Bn - 0.3));
    css(els.ring, { left: `${rx}px`, top: `${ry}px`, width: '560px', height: '88px' });
    tf(els.ring, `scale(${1.1 - 0.1 * rk})`); op(els.ring, rk);
    const [lx, ly] = F(1040, 358);
    css(els.call, { left: `${lx}px`, top: `${ly}px` });
    const lk = EP(t, T.broke - 0.05, T.broke + 0.35, 'expo.out') * (1 - P(t, Bn - 0.6, Bn - 0.3));
    tf(els.call, `translateY(${(1 - lk) * 16}px) scale(${0.55})`); els.call.style.transformOrigin = '0 0'; op(els.call, lk);
    // ── camera ──
    let cam;
    if (t < VIN + 0.6) {
      cam = { x: kf(t, [[A, 0], [T.download, 0], [T.open, 0, 'power2.inOut']]), y: kf(t, [[A, -170], [T.download, -110], [T.open, 210, 'power2.inOut']]),
        s: kf(t, [[A - 0.3, 0.92], [A + 1.2, 1.12, 'expo.out'], [T.download, 1.06], [T.open, 1.4]]), ry: kf(t, [[A, 8], [T.open, -4]]), rx: 2 };
      const ft = EP(t, VIN, VIN + 0.6, 'expo.inOut');
      const [wx, wy] = F(800, 500);
      cam = { x: E.lerp(cam.x, wx, ft), y: E.lerp(cam.y, wy, ft), s: E.lerp(cam.s, 1.2, ft), ry: cam.ry * (1 - ft), rx: cam.rx * (1 - ft) };
    } else {
      const K = [
        [VIN + 0.6, 800, 500, 1.2], [T.time - 0.4, 800, 500, 1.2], [T.time + 0.1, 330, 380, 1.9, 'power3.inOut'], [T.actions - 0.3, 360, 420, 1.95],
        [T.actions + 0.05, 420, 470, 1.55, 'whip'], [T.network + 0.3, 440, 480, 1.6],
        [T.exactly - 0.2, 1290, 300, 2.0, 'power3.inOut'], [T.broke + 0.55, 1300, 310, 2.05], [Bn - 0.4, 800, 500, 1.2, 'power3.inOut'], [Bn + 0.3, 800, 500, 1.15],
      ];
      const s = kf(t, K.map(([a, , , v, e]) => [a, v, e]));
      const fx = kf(t, K.map(([a, x, , , e]) => [a, x, e])), fy = kf(t, K.map(([a, , y, , e]) => [a, y, e]));
      const [wx, wy] = F(...E.clampFocus(fx, fy, s));
      cam = { x: wx, y: wy, s };
    }
    // exit: the viewer drops back into depth as the feature montage hits
    const ex = EP(t, Bn - 0.25, Bn + 0.3, 'power3.in');
    cam.s *= 1 - 0.45 * ex;
    E.cam(world, cam);
    op(world, P(t, A - 0.3, A) * (1 - P(t, Bn - 0.05, Bn + 0.3)));
    chap.update(t, A + 0.3, T.download - 0.3);
    return job;
  };
  SCENES.push(S);
})();

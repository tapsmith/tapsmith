// ─── Scene 1 · The problem (0–16 s) ───
// One continuous camera move down a column of "stations", whip-panning on the
// VO's beats: lag race → setup errors → flaky selector → sleep → YAML wall.
// Cold palette: steel whites, signal red. Warmth is withheld until the turn.
(function () {
  const { h, kf, P, EP, op, tf, css, clamp, splitWords, rng, noise1 } = E;
  const GAP = 1300;                                   // vertical spacing between stations
  const Y = [0, 1, 2, 3, 4].map((i) => i * GAP);
  const w1 = (w, n) => W('1', w, 's', n);
  const T = {
    mobile: w1('mobile'), web: w1('web'), while_: w1('while'),
    days: w1('days'), driver: w1('driver'), upkeep: w1('upkeep'),
    flaky: w1('flaky'), selectors: w1('selectors'),
    hard: w1('hard'), sleeps: w1('sleeps'),
    declarative: w1('declarative'), flows: w1('flows'), wall: w1('wall'), real: w1('real'), logic: w1('logic'),
  };
  // whip-pan windows between stations (start, end)
  const WHIPS = [[T.days - 0.36, T.days - 0.02], [T.flaky - 0.34, T.flaky - 0.02], [T.hard - 0.32, T.hard - 0.02], [T.declarative - 0.34, T.declarative - 0.02]];
  WHIPS.forEach(([a]) => cue(a, 'whoosh', { dur: 0.4, pan: 0, gain: 0.8 }));

  const COLD = '#e3e9f0', RED = '#ff5a52', CYAN = '#7fe3d0';
  const CSS = `
  #sc-problem .cap { position:absolute; left:0; transform:translateX(-50%); font-size:118px; color:${COLD}; text-align:center; }
  #sc-problem .lane-word { position:absolute; font-size:150px; color:${COLD}; transform:translateX(-100%); }
  #sc-problem .track { position:absolute; height:8px; border-radius:4px; background:rgba(220,230,240,0.10); overflow:visible; }
  #sc-problem .fill { position:absolute; left:0; top:0; bottom:0; border-radius:4px; }
  #sc-problem .head { position:absolute; top:50%; width:22px; height:22px; margin:-11px 0 0 -11px; border-radius:50%; }
  #sc-problem .lane-meta { position:absolute; font:500 30px 'JetBrains Mono',monospace; letter-spacing:0.02em; white-space:nowrap; }
  #sc-problem .spinner { width:30px; height:30px; border-radius:50%; border:4px solid rgba(220,230,240,0.18); border-top-color:${COLD}; display:inline-block; vertical-align:-6px; margin-right:14px; }
  #sc-problem .term { position:absolute; width:1080px; padding:22px 30px; border-radius:16px; background:linear-gradient(180deg,#191d23,#12151a);
     border:1px solid rgba(200,215,230,0.12); box-shadow:0 40px 100px rgba(0,0,0,0.6); font:400 27px 'JetBrains Mono',monospace; line-height:1.55; white-space:pre; color:#aeb8c4; }
  #sc-problem .term .x { color:${RED}; }
  #sc-problem .term .bar3 { position:absolute; right:22px; top:18px; display:flex; gap:7px; } #sc-problem .term .bar3 i { width:10px; height:10px; border-radius:50%; background:#2c323a; display:block; }
  #sc-problem .daytag { position:absolute; left:0; transform:translateX(-50%); white-space:nowrap; font:600 26px 'JetBrains Mono',monospace; letter-spacing:0.3em; color:${RED}; }
  #sc-problem .xpath { position:absolute; left:0; transform:translateX(-50%); font:400 40px 'JetBrains Mono',monospace; white-space:pre; color:${COLD}; line-height:1.4; text-align:left; }
  #sc-problem .row { position:absolute; left:0; width:1040px; transform:translateX(-50%); height:96px; border-radius:18px; display:flex; align-items:center; gap:26px;
     padding:0 34px; background:linear-gradient(180deg,#191d23,#12151a); border:1px solid rgba(200,215,230,0.12); font:500 34px 'Inter'; color:#c9d2dc; }
  #sc-problem .pill { width:150px; height:52px; border-radius:26px; display:flex; align-items:center; justify-content:center; font:700 24px 'JetBrains Mono',monospace; letter-spacing:0.1em; }
  #sc-problem .sleep { position:absolute; left:0; transform:translateX(-50%); font:400 110px 'JetBrains Mono',monospace; white-space:pre; color:${COLD}; }
  #sc-problem .yaml { position:absolute; left:0; width:1040px; height:370px; transform:translateX(-50%); border-radius:18px; overflow:hidden;
     background:linear-gradient(180deg,#191d23,#12151a); border:1px solid rgba(200,215,230,0.12); box-shadow:0 40px 100px rgba(0,0,0,0.6); }
  #sc-problem .yaml .lines { position:absolute; left:44px; top:0; font:400 34px 'JetBrains Mono',monospace; line-height:56px; white-space:pre; color:#c3ccd6; }
  #sc-problem .yaml .c-key { color:#9fb3c8; } #sc-problem .yaml .c-str { color:#d6dde5; }
  #sc-problem .barrier { position:absolute; left:-560px; width:1120px; height:6px; border-radius:3px; background:${RED}; box-shadow:0 0 30px ${RED}, 0 0 80px rgba(255,90,82,0.5); }
  #sc-problem .logic { position:absolute; left:0; transform:translateX(-50%); font:400 38px 'JetBrains Mono',monospace; white-space:pre; }
  #sc-problem .logic .ch { display:inline-block; }
  #sc-problem .reject { position:absolute; left:0; transform:translateX(-50%); font:600 26px 'JetBrains Mono',monospace; color:${RED}; letter-spacing:0.06em; white-space:nowrap; }
  `;
  h('style', '', document.head, CSS);

  const S = { id: 'problem', range: [0, 16.2] };
  let world, els = {};

  S.build = (root) => {
    ({ world } = E.viewport(root));
    // ── station 0: the lag race ──
    const st0 = h('div', '', world); st0.style.top = '40px';
    const lane = (y, word) => {
      const w = h('div', 'kin lane-word', st0); css(w, { left: '-170px', top: `${y - 92}px` });
      const words = splitWords(w, word);
      const tr = h('div', 'track', st0); css(tr, { left: '-100px', top: `${y - 4}px`, width: '780px' });
      const fill = h('div', 'fill', tr);
      const head = h('div', 'head', tr);
      const meta = h('div', 'lane-meta', st0); css(meta, { left: '-100px', top: `${y + 34}px` });
      return { w, words, tr, fill, head, meta };
    };
    els.mob = lane(-110, 'Mobile');
    els.web = lane(150, 'Web');
    css(els.mob.fill, { background: `linear-gradient(90deg, rgba(220,230,240,0.25), ${COLD})` });
    css(els.mob.head, { background: COLD, boxShadow: `0 0 24px ${COLD}` });
    css(els.web.fill, { background: `linear-gradient(90deg, rgba(127,227,208,0.25), ${CYAN})` });
    css(els.web.head, { background: CYAN, boxShadow: `0 0 30px ${CYAN}` });
    els.mob.meta.innerHTML = '<span class="spinner"></span><span class="pct">0%</span>';
    els.mob.spin = els.mob.meta.querySelector('.spinner');
    els.mob.pct = els.mob.meta.querySelector('.pct');
    els.web.meta.innerHTML = `<span style="color:${CYAN}">✓ passed · 1.2s</span>`;
    els.st0 = st0;

    // ── station 1: setup avalanche ──
    const st1 = h('div', '', world); st1.style.top = Y[1] + 'px'; st1.style.transformStyle = 'preserve-3d';
    els.day = h('div', 'daytag', st1); css(els.day, { top: '-412px' });
    els.cap1 = h('div', 'kin cap', st1); css(els.cap1, { top: '-350px' });
    els.cap1w = splitWords(els.cap1, 'Days of setup.');
    els.cap1b = h('div', 'kin cap', st1); css(els.cap1b, { top: '-350px' });
    els.cap1bw = splitWords(els.cap1b, 'Driver upkeep.');
    const TERMS = [
      ['$ start-server --port 4723', '<span class="x">✕</span> Error: listen EADDRINUSE :::4723'],
      ['$ xcodebuild -scheme Runner test', '<span class="x">✕</span> Testing failed: Runner failed to build'],
      ['$ adb devices', '<span class="x">✕</span> emulator-5554    offline'],
      ['POST /session', '<span class="x">✕</span> Could not start a new session (500)'],
      ['capabilities.platformVersion', '<span class="x">✕</span> "platformVersion" is required'],
    ];
    const r = rng(7);
    els.terms = TERMS.map(([a, b], i) => {
      const d = h('div', 'term', st1, `<div class="bar3"><i></i><i></i><i></i></div>${a}\n${b}`);
      return { d, x: -540 + (i % 2 ? 50 : -50) + (r() - 0.5) * 70, y: -180 + i * 98, rz: (r() - 0.5) * 5, at: [T.days - 0.02, T.days + 0.36, T.driver - 0.12, T.driver + 0.24, T.upkeep + 0.22][i] };
    });
    els.terms.forEach((o, i) => cue(o.at + 0.04, 'slam', { gain: 0.55 + 0.08 * i }));

    // ── station 2: flaky selector ──
    const st2 = h('div', '', world); st2.style.top = Y[2] + 'px';
    els.cap2 = h('div', 'kin cap', st2); css(els.cap2, { top: '-380px' });
    els.cap2w = splitWords(els.cap2, 'Flaky selectors.');
    const XP = '//android.widget.FrameLayout[1]\n  /android.view.ViewGroup[3]\n  /android.widget.TextView[2]';
    els.xp = ['#ff3b5c', '#3be8ff', COLD].map((c, i) => {
      const d = h('div', 'xpath', st2, E.esc(XP)); css(d, { top: '-150px', color: c, mixBlendMode: i < 2 ? 'screen' : 'normal', opacity: i < 2 ? 0.8 : 1 });
      return d;
    });
    els.row = h('div', 'row', st2); css(els.row, { top: '150px' });
    els.row.innerHTML = '<div class="pill"></div><span>checkout › applies discount</span><span style="margin-left:auto;font:400 26px JetBrains Mono;color:#7d8794" class="att"></span>';
    els.pill = els.row.querySelector('.pill');
    els.att = els.row.querySelector('.att');
    // irregular pass/fail flips
    els.flips = [];
    const fr = rng(42);
    let ft = T.flaky + 0.05;
    while (ft < T.hard - 0.3) { els.flips.push(ft); ft += 0.13 + fr() * 0.22; }
    els.flips.forEach((t) => cue(t, 'glitch', { gain: 0.35 }));

    // ── station 3: the sleep ──
    const st3 = h('div', '', world); st3.style.top = Y[3] + 'px';
    els.cap3 = h('div', 'kin cap', st3); css(els.cap3, { top: '-420px' });
    els.cap3w = splitWords(els.cap3, 'Hard-coded sleeps.');
    els.ring = h('div', '', st3);
    els.ring.innerHTML = `<svg width="460" height="460" viewBox="-280 -280 560 560" style="position:absolute;left:-230px;top:-272px;overflow:visible">
      <circle r="240" fill="none" stroke="rgba(220,230,240,0.08)" stroke-width="10"/>
      <circle class="arc" r="240" fill="none" stroke="${COLD}" stroke-width="10" stroke-linecap="round" transform="rotate(-90)" stroke-dasharray="1508" stroke-dashoffset="0"/>
      ${[...Array(60)].map((_, i) => `<line x1="0" y1="-262" x2="0" y2="${i % 5 ? -270 : -280}" stroke="rgba(220,230,240,${i % 5 ? 0.18 : 0.4})" stroke-width="2" transform="rotate(${i * 6})"/>`).join('')}
    </svg>`;
    els.arc = els.ring.querySelector('.arc');
    els.sleep = h('div', 'sleep', st3, '<span style="color:#9fb3c8">await</span> sleep(<span class="n" style="color:#ffcf7a">5000</span>)');
    css(els.sleep, { top: '238px', fontSize: '72px' });
    els.count = h('div', 'lane-meta', st3); css(els.count, { left: '0', top: '-108px', transform: 'translateX(-50%)', color: COLD, font: "800 120px 'Inter'", letterSpacing: '-0.04em' });

    // ── station 4: the wall ──
    const st4 = h('div', '', world); st4.style.top = Y[4] + 'px';
    els.st4 = st4;
    els.cap4 = h('div', 'kin cap', st4); css(els.cap4, { top: '-405px' });
    els.cap4w = splitWords(els.cap4, 'Declarative flows…');
    els.cap4b = h('div', 'kin cap', st4); css(els.cap4b, { top: '-292px', color: RED, fontSize: '96px' });
    els.cap4bw = splitWords(els.cap4b, 'hit a wall.');
    els.yaml = h('div', 'yaml', st4); css(els.yaml, { top: '-160px' });
    const YL = ['appId: com.acme.shop', '---', '- launchApp', '- tapOn: "Shop"', '- tapOn: "Add to cart"', '- tapOn: "Cart"', '- assertVisible: "1 item"',
      '- tapOn: "Promo code"', '- inputText: "LAUNCH20"', '- tapOn: "Apply"', '- assertVisible: "20% off"', '- tapOn: "Checkout"', '- runFlow: pay.yaml', '- assertVisible: "Paid"'];
    els.ylines = h('div', 'lines', els.yaml, YL.map((l) => E.hl(l, 'yaml')).join('\n'));
    els.barrier = h('div', 'barrier', st4); css(els.barrier, { top: '213px' });
    const LOGIC = 'if (cart.total > 100) applyCoupon()';
    els.logic = h('div', 'logic', st4); css(els.logic, { top: '250px' });
    els.logic.innerHTML = E.hl(LOGIC);
    // per-char spans for the shatter (wrap text nodes inside highlighted spans)
    const wrapChars = (node) => {
      for (const c of [...node.childNodes]) {
        if (c.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const ch of c.textContent) { const s = document.createElement('span'); s.className = 'ch'; s.textContent = ch === ' ' ? ' ' : ch; frag.appendChild(s); }
          c.replaceWith(frag);
        } else wrapChars(c);
      }
    };
    wrapChars(els.logic);
    els.lch = [...els.logic.querySelectorAll('.ch')];
    const sr = rng(99);
    els.lchv = els.lch.map(() => ({ vx: (sr() - 0.5) * 900, vy: -200 - sr() * 500, rot: (sr() - 0.5) * 720 }));
    els.reject = h('div', 'reject', st4, '✕ NOT EXPRESSIBLE IN A FLOW FILE'); css(els.reject, { top: '330px' });

    cue(T.wall + 0.02, 'boom', { gain: 1.0 });
    cue(T.logic + 0.12, 'shatter', { gain: 0.9 });
    E.burst({ t: T.logic + 0.14, x: 960, y: 540 + 1.18 * 250 + 10, n: 70, speed: 1100, spread: Math.PI * 1.2, angle: -Math.PI / 2, life: 1.0, size: 2.6, color: '#ff6a5c', gravity: 1400, seed: 5, kind: 'streak', ox: 600 });
  };

  S.update = (t) => {
    // ── camera: hold on each station, whip between them ──
    const keys = [[0, 0]];
    WHIPS.forEach(([a, b], i) => { keys.push([a, Y[i]]); keys.push([b, Y[i + 1], 'whip']); });
    let cy = kf(t, keys);
    // whip dynamics: dip scale + roll while travelling
    let dip = 0, roll = 0;
    WHIPS.forEach(([a, b], i) => { const k = P(t, a, b); const bell = Math.sin(Math.PI * k); dip += bell; roll += bell * (i % 2 ? -1 : 1); });
    const push = kf(t, [[0, 0.95], [5, 1.03, 'none']]);
    const sk = E.shake(t, [...els.terms.map((o) => [o.at + 0.03, 0.55, 0.4]), [T.wall + 0.02, 1.6, 0.8], [T.logic + 0.12, 1.0, 0.6]], 3);
    const endPull = EP(t, 14.6, 16.2, 'power2.in');
    E.cam(world, { x: sk.x, y: cy + sk.y + endPull * -40, s: 1.18 * (t < 5 ? push : 1.0) * (1 - 0.1 * dip) * (1 - 0.12 * endPull), rz: roll * 1.6 + sk.r, rx: 0 });
    // scene fade-out into the dark before the turn
    op(world, 1 - P(t, 14.9, 15.85));

    // ── station 0 ──
    if (t < 6) {
      const reveal = (words, t0, stagger = 0.06, ease = 'expo.out') => words.forEach((w, i) => {
        const k = EP(t, t0 + i * stagger, t0 + i * stagger + 0.6, ease);
        tf(w, `translateY(${(1 - k) * 110}%)`);
      });
      reveal(els.mob.words, T.mobile - 0.05);
      // mobile lags: its word jitters in late, its bar crawls and stalls
      const mp = kf(t, [[T.mobile + 0.3, 0], [T.mobile + 0.9, 0.09, 'power1.out'], [T.mobile + 1.6, 0.12], [T.mobile + 1.9, 0.12], [T.mobile + 2.6, 0.24, 'power2.inOut'], [T.while_ + 0.1, 0.27], [8, 0.28]]);
      css(els.mob.fill, { width: `${mp * 100}%` });
      css(els.mob.head, { left: `${mp * 100}%` });
      op(els.mob.head, P(t, T.mobile + 0.3, T.mobile + 0.5));
      op(els.mob.meta, P(t, T.mobile + 0.4, T.mobile + 0.8));
      tf(els.mob.spin, `rotate(${(t * 400) % 360}deg)`);
      els.mob.pct.textContent = `${Math.round(mp * 100)}%`;
      // web: arrives on "web" and blows past
      reveal(els.web.words, T.web - 0.12);
      const wp = EP(t, T.web + 0.05, T.web + 0.6, 'expo.inOut');
      css(els.web.fill, { width: `${wp * 100}%` });
      css(els.web.head, { left: `${wp * 100}%` });
      op(els.web.head, P(t, T.web, T.web + 0.1));
      op(els.web.meta, P(t, T.web + 0.6, T.web + 0.8));
      tf(els.web.meta, `translateY(${(1 - EP(t, T.web + 0.6, T.web + 0.9)) * 16}px)`);
      op(els.web.tr, P(t, T.web - 0.2, T.web));
      op(els.mob.tr, P(t, T.mobile, T.mobile + 0.3));
    }
    // ── station 1 ──
    if (t > 4.6 && t < 8.2) {
      els.cap1w.forEach((w, i) => { const k = EP(t, T.days + i * 0.07, T.days + 0.55 + i * 0.07, 'expo.out'); const o = EP(t, T.driver - 0.15, T.driver + 0.1, 'power2.in'); tf(w, `translateY(${(1 - k) * 110 - o * 110}%)`); });
      els.cap1bw.forEach((w, i) => { const k = EP(t, T.driver - 0.05 + i * 0.07, T.driver + 0.5 + i * 0.07, 'expo.out'); tf(w, `translateY(${(1 - k) * 110}%)`); });
      const d = t < T.driver - 0.12 ? 1 : t < T.upkeep + 0.22 ? 2 : 3;
      els.day.textContent = `DAY ${d}`;
      op(els.day, P(t, T.days, T.days + 0.2));
      els.terms.forEach((o, i) => {
        const k = EP(t, o.at - 0.18, o.at, 'power3.in');
        const z = (1 - k) * 1400;
        const settle = EP(t, o.at, o.at + 0.5, 'power2.out');
        css(o.d, { left: `${o.x}px`, top: `${o.y}px` });
        tf(o.d, `translate3d(0, ${-(1 - k) * 60}px, ${z}px) rotateZ(${o.rz * (1 - 0.4 * settle)}deg) rotateX(${(1 - k) * 25}deg)`);
        op(o.d, P(t, o.at - 0.2, o.at - 0.1));
        o.d.style.filter = `brightness(${1 + 0.8 * (1 - settle) * (t >= o.at ? 1 : 0)})`;
      });
    }
    // ── station 2 ──
    if (t > 7.0 && t < 9.8) {
      els.cap2w.forEach((w, i) => { const k = EP(t, T.flaky + i * 0.07, T.flaky + 0.55 + i * 0.07, 'expo.out'); tf(w, `translateY(${(1 - k) * 110}%)`); });
      // glitch: offsets change on a 15 fps grid, with occasional big tears
      const g = Math.floor(t * 15);
      const amp = 4 + 22 * Math.max(0, noise1(g * 0.9, 3));
      els.xp.forEach((d, i) => {
        if (i === 2) { tf(d, `translateX(-50%) translateX(${noise1(g, 9) * 3}px)`); return; }
        const s = i ? -1 : 1;
        tf(d, `translateX(-50%) translate(${s * amp * (0.4 + Math.abs(noise1(g * 1.3, i)))}px, ${noise1(g * 0.7, i + 4) * 4}px)`);
        const cut = 20 + 60 * Math.abs(noise1(g * 2.1, i + 2));
        d.style.clipPath = Math.abs(noise1(g * 1.7, 5)) > 0.45 ? `inset(${cut}% 0 ${100 - cut - 18}% 0)` : 'none';
      });
      op(els.xp[0].parentNode === undefined ? els.xp[0] : els.xp[0], 1);
      const ok = els.flips.filter((f) => t >= f).length % 2 === 0;
      css(els.pill, { background: ok ? 'rgba(95,211,141,0.16)' : 'rgba(255,90,82,0.18)', color: ok ? '#5fd38d' : RED, border: `1.5px solid ${ok ? 'rgba(95,211,141,0.5)' : 'rgba(255,90,82,0.6)'}` });
      els.pill.textContent = ok ? 'PASS' : 'FAIL';
      els.att.textContent = `run #${41 + els.flips.filter((f) => t >= f).length}`;
      const rk = EP(t, T.flaky + 0.1, T.flaky + 0.6, 'expo.out');
      tf(els.row, `translateX(-50%) translateY(${(1 - rk) * 40}px)`); op(els.row, rk);
    }
    // ── station 3 ──
    if (t > 8.6 && t < 11.3) {
      els.cap3w.forEach((w, i) => { const k = EP(t, T.hard + i * 0.07, T.hard + 0.55 + i * 0.07, 'expo.out'); tf(w, `translateY(${(1 - k) * 110}%)`); });
      // time drags: the ring drains slowly, ticking in discrete steps
      const step = Math.floor(P(t, T.hard + 0.2, 11.2) * 14) / 14;
      els.arc.setAttribute('stroke-dashoffset', (1508 * step * 0.3).toFixed(1));
      const remaining = 5.0 - step * 1.5;
      els.count.textContent = `${remaining.toFixed(1)}s`;
      op(els.count, P(t, T.hard - 0.05, T.hard + 0.2));
      tf(els.sleep, `translateX(-50%) translateY(${(1 - EP(t, T.hard + 0.05, T.hard + 0.6, 'expo.out')) * 40}px)`); op(els.sleep, P(t, T.hard + 0.05, T.hard + 0.3)); tf(els.ring, `scale(${0.85 + 0.15 * EP(t, T.hard - 0.1, T.hard + 0.6, 'expo.out')})`);
    }
    // ── station 4 ──
    if (t > 10.2) {
      els.cap4w.forEach((w, i) => { const k = EP(t, T.declarative - 0.04 + i * 0.08, T.declarative + 0.5 + i * 0.08, 'expo.out'); tf(w, `translateY(${(1 - k) * 110}%)`); });
      els.cap4bw.forEach((w, i) => { const k = EP(t, T.wall - 0.25 + i * 0.05, T.wall + 0.0 + i * 0.05, 'power4.in'); tf(w, `translateY(${(1 - k) * 110}%) scale(${1 + 0.25 * (1 - EP(t, T.wall, T.wall + 0.4))})`); });
      // the flow scrolls up steadily... then stops dead against the wall
      const v = 128;                            // px/s
      const tw = T.wall + 0.02;
      const scroll = t < tw ? (t - T.flows + 0.3) * v : (tw - T.flows + 0.3) * v + 26 * Math.exp(-(t - tw) * 9) * Math.sin((t - tw) * 40);
      tf(els.ylines, `translateY(${-Math.max(0, scroll) + 12}px)`);
      const jolt = t >= tw ? Math.exp(-(t - tw) * 7) : 0;
      tf(els.yaml, `translateX(-50%) translateY(${jolt * 18}px) scaleY(${1 - 0.04 * jolt})`);
      els.yaml.style.filter = `brightness(${1 + 0.6 * jolt})`;
      const bk = P(t, tw - 0.02, tw + 0.05);
      op(els.barrier, bk * (0.75 + 0.25 * Math.exp(-(t - tw) * 3)));
      tf(els.barrier, `scaleX(${EP(t, tw - 0.05, tw + 0.25, 'expo.out')})`);
      // real logic arrives from below, hits the barrier, shatters
      const lt0 = T.real - 0.35, hit = T.logic + 0.12;
      const lk = EP(t, lt0, hit, 'power2.in');
      tf(els.logic, `translateX(-50%) translateY(${(1 - lk) * 180 - lk * 30}px)`);
      op(els.logic, P(t, lt0, lt0 + 0.2));
      const dt = t - hit;
      els.lch.forEach((c, i) => {
        if (dt <= 0) { tf(c, 'none'); c.style.opacity = ''; return; }
        const o = els.lchv[i];
        tf(c, `translate(${o.vx * dt}px, ${o.vy * dt + 1600 * dt * dt}px) rotate(${o.rot * dt}deg)`);
        c.style.opacity = Math.max(0, 1 - dt * 1.4).toFixed(3);
      });
      els.logic.style.color = dt > 0 ? RED : '';
      op(els.reject, P(t, hit + 0.08, hit + 0.2));
      tf(els.reject, `translateX(-50%) translateY(${(1 - EP(t, hit + 0.08, hit + 0.4)) * 20}px)`);
    }
  };
  SCENES.push(S);
})();

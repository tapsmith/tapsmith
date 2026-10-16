// ─── Scene 3 · Real TypeScript (18.6–34 s) ───
// A YAML flow morphs into a Tapsmith test: the strings both share fly to their
// new homes while the syntax around them dissolves and re-forms. Then the
// editor shows what YAML can't: autocomplete, types, helpers — and the same
// test drives iOS and Android, installed with one npm command.
(function () {
  const { h, kf, P, EP, op, tf, css, hl, esc, win } = E;
  const w2 = (w, n) => W('2b', w, 's', n);
  const T = {
    yaml: w2('yaml'), but: w2('but'), ts: w2('typescript'), auto: w2('autocomplete'), type: w2('type', 1), reuse: w2('reusable'),
    one: w2('one'), ios: w2('ios'), android: w2('android'), npm: w2('npm'), install: w2('install'), server: w2('server'), drivers: w2('drivers'),
  };
  const ENTER = 18.75, EXIT = 33.2;
  const EW = 1560, EH = 560, BAR = 64, PADT = 34, GUT = 104, LH = 52, FS = 28;

  const YAML = ['appId: com.acme.shop', '---', '- launchApp', '- tapOn: "Promo code"', '- inputText: "LAUNCH20"', '- tapOn: "Apply"', '- assertVisible: "20% off"'];
  const TS = [
    "import { test, expect } from 'tapsmith'",
    '',
    "test('promo code applies a discount', async ({ device }) => {",
    "  await device.getByRole('textfield', { name: 'Promo code' }).type('LAUNCH20')",
    "  await device.getByRole('button', { name: 'Apply' }).tap()",
    "  await expect(device.getByText('20% off')).toBeVisible()",
    '})',
  ];
  const TYPED = 'toBe';                       // typed on row 5 before autocomplete
  const ROW5_PRE = "  await expect(device.getByText('20% off')).";
  const HELPER = "  await applyPromo(device, 'LAUNCH20')";
  const FLY = [['Promo code', 3, 3], ['LAUNCH20', 4, 3], ['Apply', 5, 4], ['20% off', 6, 5]];
  const blank = (line, s) => line.replace(s, ' '.repeat(s.length));

  const CSS = `
  #sc-code .ed { position:absolute; left:${-EW / 2}px; top:${-EH / 2}px; width:${EW}px; height:${EH}px; overflow:hidden; }
  #sc-code .ed .bar { height:${BAR}px; display:flex; align-items:center; gap:10px; padding:0 26px; border-bottom:1px solid var(--line); position:relative; }
  #sc-code .ed .bar i { width:14px; height:14px; border-radius:50%; display:block; }
  #sc-code .tab { position:absolute; left:130px; top:0; height:${BAR}px; display:flex; align-items:center; gap:12px; padding:0 26px;
     font:400 22px 'JetBrains Mono',monospace; color:var(--sand); border-left:1px solid var(--line); border-right:1px solid var(--line); background:rgba(255,255,255,0.025); }
  #sc-code .tab .nm { position:relative; display:inline-block; overflow:hidden; height:30px; width:250px; }
  #sc-code .tab .nm span { position:absolute; left:0; top:0; line-height:30px; white-space:nowrap; }
  #sc-code .badge { position:absolute; right:26px; top:14px; height:36px; display:flex; align-items:center; gap:10px; padding:0 18px; border-radius:18px; font:600 18px 'Inter'; white-space:nowrap; }
  #sc-code .badge.y { color:#aab6c4; border:1px solid rgba(170,182,196,0.35); }
  #sc-code .badge.t { color:var(--coral); border:1px solid rgba(253,133,103,0.5); background:rgba(253,133,103,0.1); }
  #sc-code .body { position:absolute; left:0; top:${BAR}px; right:0; bottom:0; font:400 ${FS}px 'JetBrains Mono',monospace; color:#e9e2da; }
  #sc-code .ln { position:absolute; left:0; width:${GUT - 36}px; text-align:right; color:#4e463f; font-size:${FS - 4}px; line-height:${LH}px; }
  #sc-code .cl { position:absolute; left:${GUT}px; height:${LH}px; line-height:${LH}px; white-space:pre; }
  #sc-code .y .c-key { color:#9fb3c8; } #sc-code .y { color:#c3ccd6; }
  #sc-code .fly { position:absolute; white-space:pre; line-height:${LH}px; color:#b5dd96; }
  #sc-code .sel { position:absolute; left:${GUT - 10}px; height:${LH}px; background:rgba(253,133,103,0.16); border-radius:6px; transform-origin:0 50%; }
  #sc-code .ac { position:absolute; width:440px; border-radius:12px; overflow:hidden; background:#241e19; border:1px solid #4a4036; box-shadow:0 30px 80px rgba(0,0,0,0.6);
     font:400 24px 'JetBrains Mono',monospace; transform-origin:0 0; }
  #sc-code .ac div { padding:9px 18px; color:#c9c1b7; display:flex; gap:14px; } #sc-code .ac div.on { background:rgba(253,133,103,0.2); color:#fff3ea; }
  #sc-code .ac i { color:#93b9ff; font-style:normal; } #sc-code .ac em { margin-left:auto; color:#6d655c; font-style:normal; font-size:19px; }
  #sc-code .tip { position:absolute; width:900px; padding:18px 24px; border-radius:12px; background:#241e19; border:1px solid #4a4036; box-shadow:0 30px 80px rgba(0,0,0,0.6);
     font:400 22px 'JetBrains Mono',monospace; color:#e9e2da; white-space:pre-wrap; transform-origin:0 100%; }
  #sc-code .tip .doc { font:400 20px 'Inter'; color:#a89f93; margin-top:10px; padding-top:10px; border-top:1px solid #3a322b; }
  #sc-code .cursor { position:absolute; width:30px; height:30px; }
  #sc-code .helper { position:absolute; width:760px; padding:26px 30px; font:400 21px 'JetBrains Mono',monospace; line-height:1.65; white-space:pre; color:#e9e2da; }
  #sc-code .helper .fn-title { font:600 16px 'Inter'; letter-spacing:0.14em; color:var(--coral); text-transform:uppercase; margin-bottom:10px; display:block; }
  #sc-code .plat { position:absolute; font:700 34px 'Inter'; letter-spacing:-0.02em; color:var(--cream); transform:translateX(-50%); white-space:nowrap; }
  #sc-code .plat small { display:block; text-align:center; font:500 18px 'JetBrains Mono',monospace; color:var(--muted); letter-spacing:0.08em; margin-top:6px; }
  #sc-code .term { position:absolute; width:880px; padding:24px 30px; font:400 30px 'JetBrains Mono',monospace; white-space:pre; color:#e9e2da; }
  #sc-code .term .ok { color:var(--green); }
  #sc-code .nope { position:absolute; display:flex; align-items:center; gap:14px; padding:16px 34px; border-radius:44px; font:700 40px 'Inter'; letter-spacing:-0.02em; color:var(--cream);
     border:1px solid rgba(255,236,218,0.18); background:rgba(30,25,21,0.9); white-space:nowrap; }
  #sc-code .nope .strike { position:absolute; left:16px; right:16px; top:50%; height:4px; border-radius:2px; background:var(--coral); transform-origin:0 50%; box-shadow:0 0 16px var(--coral); }
  `;
  h('style', '', document.head, CSS);

  const S = { id: 'code', range: [18.6, 34.05] };
  let world, ed, els = {}, CW = 16.8;
  const pos = (row, col) => ({ x: GUT + col * CW, y: PADT + row * LH });

  S.build = (root) => {
    ({ world } = E.viewport(root));
    world.style.transformStyle = 'preserve-3d';
    // measure the monospace advance
    const m = h('span', 'mono', document.body, 'M'.repeat(100)); m.style.cssText = `position:absolute;visibility:hidden;font:400 ${FS}px 'JetBrains Mono',monospace`;
    CW = m.getBoundingClientRect().width / 100 || 16.8; m.remove();

    els.edWrap = h('div', '', world); els.edWrap.style.transformStyle = 'preserve-3d';
    ed = h('div', 'panel ed', els.edWrap);
    const bar = h('div', 'bar', ed, '<i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>');
    els.tab = h('div', 'tab', bar, `<span class="nm"><span class="a">checkout.flow.yaml</span><span class="b">checkout.test.ts</span></span>`);
    els.tabA = els.tab.querySelector('.a'); els.tabB = els.tab.querySelector('.b');
    els.badgeY = h('div', 'badge y', bar, 'YAML flow');
    els.badgeT = h('div', 'badge t', bar, BRAND.markSVG(20) + 'TypeScript');
    const body = (els.body = h('div', 'body', ed));
    els.gut = [...Array(7)].map((_, i) => { const d = h('div', 'ln', body, String(i + 1)); d.style.top = PADT + i * LH + 'px'; return d; });
    els.sel = h('div', 'sel', body);
    els.yl = YAML.map((l, i) => { let b = l; FLY.forEach(([s, yr]) => { if (yr === i) b = blank(b, `"${s}"`); }); const d = h('div', 'cl y', body, hl(b, 'yaml')); d.style.top = PADT + i * LH + 'px'; return d; });
    els.tl = TS.map((l, i) => { const d = h('div', 'cl', body); d.style.top = PADT + i * LH + 'px'; return d; });
    els.tsBlank = TS.map((l, i) => { let b = l; FLY.forEach(([s, , tr]) => { if (tr === i) b = blank(b, `'${s}'`); }); return b; });
    els.helperLine = h('div', 'cl', body, hl(HELPER)); els.helperLine.style.top = PADT + 3 * LH + 'px';
    els.fly = FLY.map(([s, yr, tr]) => {
      const d = h('div', 'fly', body);
      const yc = YAML[yr].indexOf(`"${s}"`), tc = TS[tr].indexOf(`'${s}'`);
      return { d, s, a: pos(yr, yc), b: pos(tr, tc) };
    });
    // autocomplete + tooltip
    const acx = GUT + ROW5_PRE.length * CW;
    els.ac = h('div', 'ac', body, ['toBeVisible', 'toBeHidden', 'toBeEnabled', 'toHaveText'].map((n, i) => `<div class="${i ? '' : 'on'}"><i>ƒ</i>${n}<em>${i === 3 ? '(text)' : '()'}</em></div>`).join(''));
    css(els.ac, { left: `${acx - 10}px`, top: `${PADT + 6 * LH + 2}px` });
    els.tip = h('div', 'tip', body, `<span class="c-cm">(method)</span> Device.<span class="c-fn">getByRole</span>(role: <span class="c-kw">string</span>, options?: ByRoleOptions): ElementHandle<div class="doc">Locate an element by its accessibility role, optionally filtered by accessible name or state.</div>`);
    const gbr = GUT + 15 * CW;
    css(els.tip, { left: `${gbr - 40}px`, top: `${PADT + 4 * LH - 168}px` });
    els.cursor = h('div', 'cursor', body, '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M5.5 3.2v16.2l4.1-4 2.3 5.4 2.7-1.2-2.3-5.3 5.6-.6z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>');
    els.cursorAt = { x: gbr + 4.5 * CW, y: PADT + 4 * LH + 30 };

    // helper card
    els.helper = h('div', 'panel helper', world, `<span class="fn-title">helpers/checkout.ts</span>${[
      'export async function applyPromo(device, code) {',
      "  await device.getByRole('textfield', { name: 'Promo code' })",
      '    .type(code)',
      "  await device.getByRole('button', { name: 'Apply' }).tap()",
      '}'].map((l) => hl(l)).join('\n')}`);

    // phones
    els.phones = ['ios', 'android'].map((p) => new BRAND.Phone(world, p));
    els.plat = [['iOS', 'Simulators &amp; devices'], ['Android', 'Emulators &amp; devices']].map(([a, b]) => h('div', 'plat', world, `${a}<small>${b}</small>`));
    // terminal + nopes
    els.term = h('div', 'panel term', world);
    els.nopes = ['Server', 'Drivers'].map((n) => h('div', 'nope', world, `<span>${n}</span><span class="strike"></span>`));
    els.strikes = els.nopes.map((n) => n.querySelector('.strike'));

    // sound
    cue(ENTER, 'whoosh', { dur: 0.7, gain: 0.7 });
    cue(T.but, 'morph', { gain: 0.9 });
    for (let i = 0; i < TYPED.length; i++) cue(T.auto - 0.4 + i * 0.09, 'key', { gain: 0.35 });
    cue(T.auto + 0.02, 'pop', { gain: 0.5 }); cue(T.auto + 0.55, 'click', { gain: 0.5 });
    cue(T.type, 'pop', { gain: 0.4 });
    cue(T.reuse + 0.35, 'fold', { gain: 0.6 });
    cue(T.one - 0.15, 'whoosh', { dur: 0.6, gain: 0.6 });
    cue(T.ios, 'thud', { gain: 0.5 }); cue(T.android, 'thud', { gain: 0.5 });
    cue(T.ios + 1.25, 'click', { gain: 0.45 });
    for (let i = 0; i < 16; i++) cue(T.npm - 0.55 + i * 0.035, 'key', { gain: 0.25 });
    cue(T.install + 0.15, 'tick', { gain: 0.6 });
    cue(T.server + 0.1, 'swipe', { gain: 0.6 }); cue(T.drivers + 0.1, 'swipe', { gain: 0.6 });
    cue(EXIT - 0.1, 'whoosh', { dur: 0.8, gain: 0.9 });
    // nope disintegration particles (screen-space positions set in update's layout)
    E.burst({ t: T.server + 0.32, x: 140, y: 880, n: 50, speed: 260, life: 1.0, size: 2, color: '#fd8567', drag: 1.5, seed: 31, ox: 220, oy: 50, gravity: -120 });
    E.burst({ t: T.drivers + 0.32, x: 480, y: 880, n: 50, speed: 260, life: 1.0, size: 2, color: '#fd8567', drag: 1.5, seed: 32, ox: 240, oy: 50, gravity: -120 });
  };

  S.update = (t) => {
    const MS = T.but - 0.02;                           // morph start
    // ── editor entrance ──
    const ek = EP(t, ENTER - 0.1, ENTER + 0.9, 'expo.out');
    // ── layout phases: centred editor → left half with phones ──
    const lay = EP(t, T.one - 0.2, T.one + 0.7, 'expo.inOut');
    const edS = 1 - 0.4 * lay;
    tf(els.edWrap, `translate3d(${-500 * lay}px, ${(1 - ek) * 600 - 170 * lay}px, ${-(1 - ek) * 400}px) rotateX(${(1 - ek) * 38}deg) rotateY(${10 * lay}deg) scale(${edS})`);
    op(els.edWrap, P(t, ENTER - 0.1, ENTER + 0.25));
    // cold → warm as the morph lands
    const warm = EP(t, MS + 0.1, MS + 0.8);
    ed.style.filter = `saturate(${0.35 + 0.65 * warm})`;

    // ── YAML lines: present, then dissolve at the morph ──
    els.yl.forEach((d, i) => {
      const k = EP(t, MS + i * 0.035, MS + 0.32 + i * 0.035, 'power2.in');
      op(d, (1 - k) * P(t, ENTER + 0.2 + i * 0.04, ENTER + 0.5 + i * 0.04));
      tf(d, `translateY(${-18 * k}px)`);
      d.style.filter = k > 0 ? `blur(${(6 * k).toFixed(2)}px)` : 'none';
    });
    // ── flying strings ──
    els.fly.forEach((f, i) => {
      const k = EP(t, MS + 0.06 + i * 0.07, MS + 0.8 + i * 0.07, 'expo.inOut');
      const x = E.lerp(f.a.x, f.b.x, k), y = E.lerp(f.a.y, f.b.y, k) - Math.sin(Math.PI * k) * 46;
      const q = k < 0.5 ? '"' : "'";
      f.d.textContent = `${q}${f.s}${q}`;
      f.d.style.color = k < 0.5 ? '#d6dde5' : '#b5dd96';
      tf(f.d, `translate(${x}px, ${y}px) scale(${1 + 0.12 * Math.sin(Math.PI * k)})`);
      f.d.style.textShadow = k > 0 && k < 1 ? `0 0 ${18 * Math.sin(Math.PI * k)}px rgba(181,221,150,0.9)` : 'none';
      op(f.d, P(t, ENTER + 0.3, ENTER + 0.6) * (t < MS + 1.2 ? 1 : 0));
    });
    // ── TS lines ──
    const settled = t >= MS + 1.2;
    const helperK = EP(t, T.reuse + 0.3, T.reuse + 0.85, 'expo.inOut');     // 3+4 fold into the helper call
    TS.forEach((l, i) => {
      const d = els.tl[i];
      let src = settled ? l : els.tsBlank[i];
      if (i === 5) {
        // row 5: the matcher is typed, then accepted from autocomplete
        const tk = P(t, T.auto - 0.42, T.auto - 0.08);
        const acc = t >= T.auto + 0.55;
        const pre = settled ? ROW5_PRE : els.tsBlank[5].slice(0, ROW5_PRE.length);
        if (acc) src = l;
        else if (t >= T.auto - 0.42) src = pre + TYPED.slice(0, Math.ceil(TYPED.length * tk));
        else src = pre;
        const caretOn = t >= T.auto - 0.6 && t < T.auto + 1.0;
        d.innerHTML = hl(src) + (caretOn ? E.caret(t) : '');
      } else d.innerHTML = hl(src);
      const k = EP(t, MS + 0.3 + i * 0.05, MS + 0.75 + i * 0.05, 'power3.out');
      d.style.clipPath = `inset(-10px ${(1 - k) * 100}% -10px -10px)`;
      op(d, k > 0 ? 1 : 0);
      // helper fold: rows 3/4 squeeze out, rows below rise one line
      let y = PADT + i * LH;
      if (i === 3 || i === 4) {
        op(d, (k > 0 ? 1 : 0) * (1 - helperK));
        tf(d, `translateY(${(i === 3 ? 0 : -LH) * helperK}px) scaleY(${1 - helperK})`);
        d.style.transformOrigin = '0 0';
      } else if (i > 4) y -= LH * helperK;
      d.style.top = y + 'px';
    });
    op(els.helperLine, helperK);
    tf(els.helperLine, `scaleY(${0.3 + 0.7 * helperK})`);
    els.gut.forEach((g, i) => op(g, P(t, ENTER + 0.2, ENTER + 0.6) * (i === 6 ? 1 - helperK : 1)));
    // selection highlight on the two lines that become a helper
    const selK = EP(t, T.reuse - 0.05, T.reuse + 0.2, 'expo.out');
    css(els.sel, { top: `${PADT + 3 * LH}px`, height: `${LH * (2 - helperK)}px`, width: `${1380 * selK}px` });
    op(els.sel, selK * (1 - P(t, T.reuse + 0.8, T.reuse + 1.1)));
    // ── chrome swap ──
    const sw = EP(t, MS + 0.25, MS + 0.6, 'expo.inOut');
    tf(els.tabA, `translateY(${-32 * sw}px)`); tf(els.tabB, `translateY(${32 * (1 - sw)}px)`);
    op(els.badgeY, 1 - P(t, MS, MS + 0.2)); op(els.badgeT, P(t, MS + 0.5, MS + 0.8));
    // ── autocomplete ──
    const acK = EP(t, T.auto - 0.05, T.auto + 0.15, 'back.out(2)') * (1 - P(t, T.auto + 0.55, T.auto + 0.65));
    op(els.ac, acK); tf(els.ac, `scale(${0.9 + 0.1 * acK})`);
    // ── type tooltip with a hovering cursor ──
    const tipK = EP(t, T.type + 0.05, T.type + 0.3, 'back.out(1.8)') * (1 - P(t, T.reuse - 0.25, T.reuse - 0.05));
    op(els.tip, tipK); tf(els.tip, `scale(${0.94 + 0.06 * tipK})`);
    const ca = els.cursorAt, ck = EP(t, T.type - 0.45, T.type, 'power3.out');
    tf(els.cursor, `translate(${ca.x + 260 * (1 - ck)}px, ${ca.y + 120 * (1 - ck)}px)`);
    op(els.cursor, P(t, T.type - 0.45, T.type - 0.3) * (1 - P(t, T.reuse - 0.25, T.reuse - 0.05)));
    // ── helper card ──
    const hk = EP(t, T.reuse + 0.35, T.reuse + 0.95, 'expo.out');
    const hout = EP(t, T.one - 0.3, T.one + 0.2, 'power2.in');
    tf(els.helper, `translate3d(${120 + 220 * (1 - hk) + 500 * hout}px, ${70}px, ${200}px) rotateY(${-14 * (1 - hk)}deg)`);
    op(els.helper, hk * (1 - hout));

    // ── phones: same test, both platforms ──
    els.phones.forEach((ph, i) => {
      const at = i ? T.android : T.ios;
      const k = EP(t, at - 0.25, at + 0.55, 'expo.out');
      const x = 70 + i * 400, y = -440;
      tf(ph.el, `translate3d(${x}px, ${y + (1 - k) * 700}px, ${(1 - k) * -300}px) rotateY(${-16 + 8 * i}deg) rotateZ(${(1 - k) * (i ? 8 : -8)}deg) scale(0.86)`);
      ph.el.style.transformOrigin = '50% 0';
      op(ph.el, P(t, at - 0.25, at));
      ph.update(t, T.ios + 0.5, T.ios + 1.25);
      const pl = els.plat[i];
      tf(pl, `translate(${x + 190}px, ${y + 726 + (1 - k) * 60}px) translateX(-50%)`);
      op(pl, P(t, at + 0.2, at + 0.5));
    });
    // ── npm install ──
    const tk2 = EP(t, T.npm - 0.8, T.npm - 0.3, 'expo.out');
    const CMD = '$ npm install -D tapsmith';
    const nT = Math.floor(CMD.length * P(t, T.npm - 0.55, T.npm));
    const done = t >= T.install + 0.15;
    els.term.innerHTML = `<span class="c-ps">$</span>${esc(CMD.slice(1, Math.max(1, nT)))}${!done ? E.caret(t) : ''}` +
      (done ? `\n<span class="ok">✓</span> <span style="color:#a89f93">added tapsmith in 2s</span>` : '\n ');
    tf(els.term, `translate3d(${-940}px, ${110 + 60 * (1 - tk2)}px, 0)`);
    op(els.term, tk2);
    // ── no server, no drivers ──
    els.nopes.forEach((n, i) => {
      const at = i ? T.drivers : T.server;
      const ink = EP(t, (i ? T.server : T.server - 0.35) + i * 0.1, (i ? T.server : T.server - 0.35) + 0.4 + i * 0.1, 'back.out(1.6)');
      const sk = EP(t, at - 0.05, at + 0.22, 'power3.out');
      const gone = EP(t, at + 0.3, at + 0.75, 'power2.in');
      els.strikes[i].style.transform = `scaleX(${sk})`;
      tf(n, `translate(${-920 + i * 330}px, ${300}px) scale(${(0.8 + 0.2 * ink) * (1 + 0.15 * gone)})`);
      op(n, ink * (1 - gone));
      n.style.filter = gone > 0 ? `blur(${10 * gone}px)` : 'none';
    });

    // ── camera ──
    const cam = { x: 0, y: 0, s: 1, rx: 0, ry: 0 };
    const keysX = [[ENTER, 0], [T.auto - 0.7, 0], [T.auto - 0.2, 60, 'power3.inOut'], [T.type - 0.3, 60], [T.type + 0.2, -170, 'power3.inOut'], [T.reuse - 0.1, -170], [T.reuse + 0.5, 60, 'power3.inOut'], [T.one - 0.2, 60], [T.one + 0.6, 0, 'expo.inOut']];
    const keysY = [[ENTER, 0], [T.auto - 0.7, 0], [T.auto - 0.2, 70, 'power3.inOut'], [T.type - 0.3, 70], [T.type + 0.2, -20, 'power3.inOut'], [T.reuse - 0.1, -20], [T.reuse + 0.5, -40, 'power3.inOut'], [T.one - 0.2, -40], [T.one + 0.6, 0, 'expo.inOut']];
    const keysS = [[ENTER, 0.9], [ENTER + 1.4, 1.0, 'power2.out'], [MS, 1.0], [MS + 0.5, 1.05, 'expo.out'], [T.auto - 0.7, 1.02], [T.auto - 0.2, 1.42, 'power3.inOut'], [T.type - 0.3, 1.42], [T.type + 0.2, 1.3, 'power3.inOut'], [T.reuse - 0.1, 1.3], [T.reuse + 0.5, 0.9, 'power3.inOut'], [T.one - 0.2, 0.9], [T.one + 0.6, 1.0, 'expo.inOut'], [EXIT, 1.03], [EXIT + 0.8, 2.6, 'power3.in']];
    cam.x = kf(t, keysX); cam.y = kf(t, keysY); cam.s = kf(t, keysS);
    cam.ry = kf(t, [[ENTER, -9], [MS, -4, 'power1.inOut'], [MS + 0.6, 0, 'expo.out'], [T.one - 0.2, 0], [T.one + 0.6, -6, 'expo.inOut'], [EXIT, -2]]);
    cam.rx = kf(t, [[ENTER, 8], [MS, 4, 'power1.inOut'], [MS + 0.6, 0, 'expo.out'], [T.one - 0.2, 0], [T.one + 0.6, 4, 'expo.inOut'], [EXIT, 2]]);
    const sk = E.shake(t, [[MS + 0.75, 0.25, 0.4]], 5);
    E.cam(world, { ...cam, x: cam.x + sk.x, y: cam.y + sk.y });
    op(world, 1 - P(t, EXIT + 0.35, EXIT + 0.8));
  };
  SCENES.push(S);
})();

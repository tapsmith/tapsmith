// ─── Scene 9 · Everything else (98–116 s) ───
// A kinetic montage cut on the VO's words: one feature per beat, a big title
// on the left and a micro-animation of the feature on the right.
(function () {
  const { h, kf, P, EP, op, tf, css, hl, splitWords } = E;
  const w8 = (w, n) => W('8', w, 's', n);
  const AT = [w8('auto'), w8('in'), w8('accessibility'), w8('parallel'), w8('multi'), w8('save'), w8('an'), w8('built')];
  const END = 115.55;
  const CSS = `
  #sc-feat .fx { position:absolute; inset:0; }
  #sc-feat .num { position:absolute; left:150px; top:372px; font:500 22px 'JetBrains Mono',monospace; letter-spacing:0.2em; color:var(--coral); }
  #sc-feat .ttl { position:absolute; left:144px; top:418px; font:800 118px 'Inter'; letter-spacing:-0.045em; line-height:1.0; color:var(--cream); white-space:nowrap; }
  #sc-feat .ttl .l { display:block; }
  #sc-feat .vis { position:absolute; left:1040px; top:250px; width:740px; height:580px; border-radius:28px; overflow:hidden;
     background:linear-gradient(180deg,rgba(40,33,27,0.92),rgba(20,16,13,0.92)); border:1px solid var(--line); box-shadow:0 60px 160px rgba(0,0,0,0.55); }
  #sc-feat .vis .in { position:absolute; inset:0; font-family:'Inter'; color:var(--cream); }
  #sc-feat .cd { position:absolute; left:40px; right:40px; top:44px; font:400 23px 'JetBrains Mono',monospace; white-space:pre; color:#e9e2da; }
  #sc-feat .pip { position:absolute; width:30px; height:30px; border-radius:50%; border:3px solid #5d544c; }
  #sc-feat .chip { position:absolute; padding:10px 20px; border-radius:22px; font:600 22px 'Inter'; white-space:nowrap; }
  #sc-feat .lane { position:absolute; left:60px; right:60px; height:54px; border-radius:12px; background:rgba(255,255,255,0.04); overflow:hidden; }
  #sc-feat .lane b { position:absolute; left:18px; top:14px; font:500 19px 'JetBrains Mono',monospace; color:var(--muted); z-index:2; }
  #sc-feat .lane i { position:absolute; left:0; top:0; bottom:0; background:linear-gradient(90deg,rgba(95,211,141,0.15),rgba(95,211,141,0.45)); border-right:3px solid #5fd38d; }
  #sc-feat .node { position:absolute; width:150px; height:150px; border-radius:36px; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:8px;
     background:rgba(255,255,255,0.05); border:1px solid rgba(255,236,218,0.14); font:600 19px 'Inter'; color:var(--sand); }
  #sc-feat .mini { position:absolute; width:200px; height:400px; border-radius:34px; background:#f3f3f5; border:9px solid #1d1d20; box-shadow:0 30px 80px rgba(0,0,0,0.5); overflow:hidden; }
  #sc-feat .mini .nv { height:58px; background:#fff; border-bottom:1px solid #e3e3e8; font:600 16px Inter; color:#111; display:flex; align-items:flex-end; justify-content:center; padding-bottom:10px; }
  #sc-feat .bub { position:absolute; padding:8px 14px; border-radius:16px; font:600 15px Inter; white-space:nowrap; }
  #sc-feat .stage { position:absolute; padding:16px 22px; border-radius:16px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,236,218,0.12); font:600 20px Inter; color:var(--sand); white-space:nowrap; display:flex; align-items:center; gap:12px; }
  #sc-feat .ok { width:28px; height:28px; border-radius:50%; background:#5fd38d; color:#0d0a08; display:flex; align-items:center; justify-content:center; font:800 15px Inter; }
  `;
  h('style', '', document.head, CSS);

  // ── per-feature visuals: build(el) returns update(lt) ──
  const V = [
    // 1 · auto-waiting assertions
    (el) => {
      const cd = h('div', 'cd', el, hl("await expect(cart.total)\n  .toHaveText('$81.60')"));
      const pips = [0, 1, 2, 3, 4].map((i) => { const p = h('div', 'pip', el); css(p, { left: `${90 + i * 120}px`, top: '300px' }); return p; });
      const line = h('div', '', el); css(line, { position: 'absolute', left: '105px', top: '313px', height: '4px', background: 'rgba(255,236,218,0.12)', width: '480px' });
      el.appendChild(pips[0]); pips.forEach((p) => el.appendChild(p));
      const lab = h('div', 'chip', el); css(lab, { left: '90px', top: '400px', font: "500 24px 'JetBrains Mono',monospace", color: 'var(--muted)', padding: '0' });
      return (lt) => {
        const n = Math.min(5, Math.floor(lt / 0.27) + 1);
        pips.forEach((p, i) => {
          const on = i < n, last = i === 4 && n === 5;
          css(p, { background: last ? '#5fd38d' : on ? 'rgba(253,133,103,0.25)' : 'transparent', borderColor: last ? '#5fd38d' : on ? '#fd8567' : '#5d544c' });
          tf(p, `scale(${on ? 1 + 0.25 * Math.exp(-(lt - i * 0.27) * 9) : 0.8})`);
        });
        lab.innerHTML = n < 5 ? `waiting… ${Math.round(lt * 1000 / 3.3)}ms` : '<span style="color:#5fd38d">✓ passed · no sleeps</span>';
      };
    },
    // 2 · in-test network mocking
    (el) => {
      const cd = h('div', 'cd', el, hl("await device.route('**/api/cart',\n  (r) => r.fulfill({ json: cart }))"));
      const ph = h('div', 'node', el, '<span style="display:block;width:30px;height:52px;border:4px solid #cfc6bb;border-radius:9px"></span>App'); css(ph, { left: '60px', top: '290px' });
      const api = h('div', 'node', el, '<span style="font:800 34px Inter;color:#cfc6bb">API</span>server'); css(api, { left: '530px', top: '290px' });
      const shield = h('div', 'chip', el, 'route()'); css(shield, { left: '300px', top: '338px', background: '#fd8567', color: '#1a120d', boxShadow: '0 0 40px rgba(253,133,103,0.6)' });
      const pk = h('div', '', el); css(pk, { position: 'absolute', width: '22px', height: '22px', borderRadius: '50%', background: '#ffd2c4', top: '354px' });
      const res = h('div', 'chip', el, '200 · MOCKED'); css(res, { left: '235px', top: '480px', border: '1.5px solid rgba(95,211,141,0.6)', color: '#5fd38d', font: "700 22px 'JetBrains Mono',monospace" });
      return (lt) => {
        const out = EP(lt, 0.15, 0.6, 'power2.in'), back = EP(lt, 0.75, 1.25, 'power2.out');
        const x = lt < 0.7 ? E.lerp(215, 330, out) : E.lerp(330, 215, back);
        css(pk, { left: `${x}px`, background: lt < 0.7 ? '#ffd2c4' : '#5fd38d' });
        op(pk, lt > 0.1 && lt < 1.3 ? 1 : 0);
        tf(shield, `scale(${1 + 0.18 * Math.exp(-Math.max(0, lt - 0.62) * 8) * (lt > 0.62 ? 1 : 0)})`);
        op(api, 1 - 0.65 * P(lt, 0.55, 0.75));
        const rk = EP(lt, 0.8, 1.15, 'back.out(2)'); op(res, rk); tf(res, `translateY(${(1 - rk) * 14}px)`);
      };
    },
    // 3 · accessibility-first locators
    (el) => {
      const cd = h('div', 'cd', el, hl("device.getByRole('button',\n  { name: 'Checkout' })"));
      const btn = h('div', '', el, 'Checkout'); css(btn, { position: 'absolute', left: '200px', top: '320px', width: '340px', height: '84px', borderRadius: '18px', background: '#0a7aff', color: '#fff', font: '700 30px Inter', display: 'flex', alignItems: 'center', justifyContent: 'center' });
      const ring = h('div', 'ring', el); css(ring, { left: '188px', top: '308px', width: '364px', height: '108px', borderRadius: '24px' });
      const c1 = h('div', 'chip', el, 'role: button'); css(c1, { left: '110px', top: '450px', background: 'rgba(147,185,255,0.14)', color: '#93b9ff', border: '1px solid rgba(147,185,255,0.4)' });
      const c2 = h('div', 'chip', el, 'name: “Checkout”'); css(c2, { left: '330px', top: '450px', background: 'rgba(181,221,150,0.14)', color: '#b5dd96', border: '1px solid rgba(181,221,150,0.4)' });
      return (lt) => {
        const rk = EP(lt, 0.2, 0.55, 'back.out(2)'); op(ring, rk); tf(ring, `scale(${1.25 - 0.25 * rk})`);
        [c1, c2].forEach((c, i) => { const k = EP(lt, 0.5 + i * 0.18, 0.85 + i * 0.18, 'back.out(2)'); op(c, k); tf(c, `translateY(${(1 - k) * -40}px)`); });
      };
    },
    // 4 · parallel workers
    (el) => {
      const lanes = [0, 1, 2, 3].map((i) => { const l = h('div', 'lane', el, `<b>worker ${i + 1}</b><i></i>`); css(l, { top: `${80 + i * 82}px` }); return l.querySelector('i'); });
      const lab = h('div', 'chip', el); css(lab, { left: '60px', top: '440px', font: "700 30px 'Inter'", padding: '0', color: 'var(--cream)' });
      const sp = [1.0, 0.82, 0.93, 0.77];
      return (lt) => {
        lanes.forEach((l, i) => css(l, { width: `${100 * E.ease('power1.inOut')(E.clamp(lt * 0.75 * sp[i]))}%` }));
        lab.innerHTML = `${Math.min(48, Math.round(lt * 36))} tests <span style="color:var(--muted);font-weight:500">· 4 devices at once</span>`;
      };
    },
    // 5 · multi-device tests
    (el) => {
      const a = h('div', 'mini', el, '<div class="nv">alice</div>'); css(a, { left: '110px', top: '90px' });
      const b = h('div', 'mini', el, '<div class="nv">bob</div>'); css(b, { left: '430px', top: '90px' });
      const m1 = h('div', 'bub', a, 'Hi Bob'); css(m1, { right: '12px', top: '90px', background: '#0a7aff', color: '#fff' });
      const m2 = h('div', 'bub', b, 'Hi Bob'); css(m2, { left: '12px', top: '90px', background: '#e6e6ea', color: '#111' });
      const fly = h('div', 'bub', el, 'Hi Bob'); css(fly, { background: '#fd8567', color: '#1a120d', top: '0', left: '0', boxShadow: '0 0 30px rgba(253,133,103,0.6)' });
      return (lt) => {
        op(m1, P(lt, 0.15, 0.3));
        const k = EP(lt, 0.3, 0.9, 'power2.inOut');
        tf(fly, `translate(${E.lerp(240, 450, k)}px, ${E.lerp(190, 190, k) - Math.sin(Math.PI * k) * 120}px)`);
        op(fly, k > 0 && k < 1 ? 1 : 0);
        op(m2, P(lt, 0.9, 1.0)); tf(m2, `scale(${0.8 + 0.2 * EP(lt, 0.9, 1.15, 'back.out(2)')})`);
      };
    },
    // 6 · save & restore app state
    (el) => {
      const cd = h('div', 'cd', el, hl("await device.saveAppState(app, 'auth.tar.gz')\nawait device.restoreAppState(app, 'auth.tar.gz')"));
      css(cd, { fontSize: '20px' });
      const card = h('div', 'stage', el, '<span style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#ffb199,#fd8567);display:block"></span>Signed in as alice');
      css(card, { left: '200px', top: '300px' });
      const box = h('div', 'node', el, '<svg width="46" height="50" viewBox="0 0 46 50"><rect x="3" y="3" width="40" height="44" rx="7" fill="none" stroke="#fd8567" stroke-width="4"/><path d="M23 3v26" stroke="#fd8567" stroke-width="4" stroke-dasharray="4 4"/><rect x="17" y="29" width="12" height="10" rx="2" fill="#fd8567"/></svg>auth.tar.gz'); css(box, { left: '295px', top: '300px' });
      return (lt) => {
        const save = EP(lt, 0.2, 0.6, 'power3.in'), restore = EP(lt, 0.9, 1.35, 'expo.out');
        tf(card, `translateY(${(lt < 0.8 ? save : 1 - restore) * 0}px) scale(${lt < 0.8 ? 1 - 0.7 * save : 0.3 + 0.7 * restore})`);
        op(card, lt < 0.8 ? 1 - save : restore);
        op(box, lt < 0.8 ? P(lt, 0.35, 0.6) : 1 - P(lt, 0.9, 1.1));
        tf(box, `scale(${0.8 + 0.2 * EP(lt, 0.35, 0.65, 'back.out(2)')})`);
      };
    },
    // 7 · MCP server for AI agents
    (el) => {
      const ag = h('div', 'node', el, '<svg width="46" height="46" viewBox="-23 -23 46 46"><path d="M0 -21 C3 -6 6 -3 21 0 C6 3 3 6 0 21 C-3 6 -6 3 -21 0 C-6 -3 -3 -6 0 -21Z" fill="#fd8567"/></svg>AI agent'); css(ag, { left: '50px', top: '215px' });
      const ts = h('div', 'node', el, BRAND.markSVG(56) + 'Tapsmith'); css(ts, { left: '295px', top: '215px', borderColor: 'rgba(253,133,103,0.5)' });
      const dv = h('div', 'node', el, '<span style="display:block;width:30px;height:52px;border:4px solid #cfc6bb;border-radius:9px"></span>device'); css(dv, { left: '540px', top: '215px' });
      const svg = h('div', '', el); css(svg, { position: 'absolute', inset: '0' });
      svg.innerHTML = '<svg width="740" height="580"><line x1="200" y1="290" x2="295" y2="290" stroke="#fd8567" stroke-width="3"/><line x1="445" y1="290" x2="540" y2="290" stroke="#fd8567" stroke-width="3"/><circle class="a" r="7" fill="#ffd2c4"/><circle class="b" r="7" fill="#ffd2c4"/></svg>';
      const ca = svg.querySelector('.a'), cb = svg.querySelector('.b');
      const lab = h('div', 'chip', el, 'list_tests · snapshot · run_tests · read_trace'); css(lab, { left: '50%', top: '430px', transform: 'translateX(-50%)', font: "500 21px 'JetBrains Mono',monospace", color: 'var(--muted)' });
      return (lt) => {
        const k = (lt * 1.6) % 1;
        ca.setAttribute('cx', 200 + 95 * k); ca.setAttribute('cy', 290);
        cb.setAttribute('cx', 445 + 95 * ((k + 0.5) % 1)); cb.setAttribute('cy', 290);
        tf(ts, `scale(${1 + 0.05 * Math.sin(lt * 10)})`);
      };
    },
    // 8 · built for CI
    (el) => {
      const st = ['push', 'install', 'test ×4 shards', 'report'].map((n, i) => { const s = h('div', 'stage', el, `<span class="ok">✓</span>${n}`); css(s, { left: `${60 + (i % 2) * 330}px`, top: `${100 + Math.floor(i / 2) * 150}px` }); return s; });
      const lab = h('div', 'chip', el, '--shard · traces on failure · HTML report'); css(lab, { left: '60px', top: '420px', padding: '0', font: "500 22px 'JetBrains Mono',monospace", color: 'var(--muted)' });
      return (lt) => st.forEach((s, i) => { const k = EP(lt, 0.1 + i * 0.22, 0.4 + i * 0.22, 'back.out(2)'); const ok = s.querySelector('.ok'); op(ok, k); tf(ok, `scale(${k})`); op(s, 0.4 + 0.6 * P(lt, i * 0.22, 0.1 + i * 0.22)); });
    },
  ];
  const TITLES = [['Auto-waiting', 'assertions'], ['In-test network', 'mocking'], ['Accessibility-first', 'locators'], ['Parallel', 'workers'],
    ['Multi-device', 'tests'], ['Save & restore', 'app state'], ['MCP server', 'for AI agents'], ['Built for CI', 'from day one']];

  const S = { id: 'feat', range: [97.6, 116.1] };
  let items = [];
  S.build = (root) => {
    TITLES.forEach((tt, i) => {
      const fx = h('div', 'fx', root);
      const num = h('div', 'num', fx, `${String(i + 1).padStart(2, '0')} / 08`);
      const ttl = h('div', 'ttl', fx);
      const lines = tt.map((l) => { const d = h('span', 'l', ttl); d.innerHTML = `<span class="mask"><span class="mask-in">${E.esc(l)}</span></span>`; return d.querySelector('.mask-in'); });
      const vis = h('div', 'vis', fx);
      const inn = h('div', 'in', vis);
      const up = V[i](inn);
      items.push({ fx, num, lines, vis, up, a: AT[i] - 0.14, b: i < 7 ? AT[i + 1] - 0.14 : END });
      cue(AT[i] - 0.16, i === 0 ? 'hit' : 'tick', { gain: i === 0 ? 0.8 : 0.55 });
      cue(AT[i] - 0.3, 'whoosh', { dur: 0.32, gain: 0.35 });
    });
    cue(END - 0.45, 'riser', { dur: 0.5, gain: 0.8 });
  };
  S.update = (t) => {
    items.forEach((it, i) => {
      const on = t >= it.a - 0.25 && t < it.b + 0.25;
      E.show(it.fx, on);
      if (!on) return;
      if (!it.fit) {      // shrink titles that would run into the visual panel
        const ttl = it.lines[0].closest('.ttl');
        const w = Math.max(...it.lines.map((l) => l.offsetWidth));
        if (w > 0) { if (w > 840) ttl.style.fontSize = `${Math.floor(118 * 840 / w)}px`; it.fit = true; }
      }
      const ik = EP(t, it.a - 0.05, it.a + 0.45, 'expo.out');
      const ok = EP(t, it.b - 0.18, it.b + 0.08, 'power3.in');
      it.lines.forEach((l, j) => tf(l, `translateY(${(1 - EP(t, it.a - 0.05 + j * 0.06, it.a + 0.5 + j * 0.06, 'expo.out')) * 110 - ok * 110}%)`));
      op(it.num, P(t, it.a, it.a + 0.2) * (1 - ok));
      tf(it.num, `translateY(${(1 - ik) * 20}px)`);
      const vx = (1 - ik) * 380 - ok * 260;
      tf(it.vis, `perspective(1600px) translateX(${vx}px) rotateY(${(1 - ik) * -32 + ok * 22}deg) scale(${0.92 + 0.08 * ik - 0.06 * ok})`);
      op(it.vis, ik * (1 - ok));
      it.up(Math.max(0, t - it.a));
    });
  };
  SCENES.push(S);
})();

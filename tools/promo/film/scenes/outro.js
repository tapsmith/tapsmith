// ─── Scene 10 · Outro (116–124 s) ───
(function () {
  const { h, kf, P, EP, op, tf, css, splitWords } = E;
  const [A, Bn] = TL.S.outro;
  const T = { get: W('9', 'get'), url: W('9', 'tapsmith') };
  const MH = 200, MW = MH * 213 / 256;
  const CSS = `
  #sc-outro .lock { position:absolute; left:0; top:-300px; display:flex; align-items:center; gap:36px; transform-origin:50% 50%; }
  #sc-outro .lock .wm { font:500 172px 'Poppins'; color:#f1ebe4; letter-spacing:-0.005em; line-height:1; white-space:nowrap; }
  #sc-outro .tag { position:absolute; left:0; top:-10px; transform:translateX(-50%); font:600 50px 'Inter'; letter-spacing:-0.025em; color:var(--sand); white-space:nowrap; }
  #sc-outro .tag b { color:var(--cream); font-weight:800; }
  #sc-outro .url { position:absolute; left:0; top:110px; transform:translateX(-50%); font:800 84px 'Inter'; letter-spacing:-0.04em; color:var(--coral); white-space:nowrap;
     text-shadow:0 0 60px rgba(253,133,103,0.45); }
  #sc-outro .npm { position:absolute; left:0; top:250px; transform:translateX(-50%); padding:18px 34px; border-radius:16px; font:400 32px 'JetBrains Mono',monospace; color:var(--cream); white-space:pre; }
  #sc-outro .halo { position:absolute; left:-900px; top:-700px; width:1800px; height:1400px; border-radius:50%;
     background:radial-gradient(closest-side, rgba(253,133,103,0.28), rgba(253,133,103,0.08) 50%, transparent 72%); }
  `;
  h('style', '', document.head, CSS);
  const S = { id: 'outro', range: [A - 0.5, Bn] };
  let world, lock, mark, wm, wmask, tag, tagW, url, urlC, npm, halo, shock;
  S.build = (root) => {
    ({ world } = E.viewport(root));
    halo = h('div', 'halo', world);
    lock = h('div', 'lock', world);
    mark = h('div', '', lock, BRAND.markSVG(MH));
    mark.firstChild.style.filter = 'drop-shadow(0 0 40px rgba(253,133,103,0.55))';
    wmask = h('div', '', lock); css(wmask, { overflow: 'hidden', padding: '20px 10px 30px 0' });
    wm = h('div', 'wm', wmask, 'Tapsmith');
    tag = h('div', 'tag', world);
    tagW = splitWords(tag, 'Mobile testing that finally feels modern.');
    tagW.slice(4).forEach((w) => { w.style.color = '#f4eee7'; w.style.fontWeight = 800; });
    url = h('div', 'url', world);
    urlC = E.splitChars(url, 'tapsmith.dev');
    npm = h('div', 'panel npm', world, '<span class="c-ps">$</span> npm install -D tapsmith');
    shock = h('div', '', world);
    css(shock, { left: '-500px', top: '-570px', width: '1000px', height: '1000px', borderRadius: '50%', border: '5px solid #ffb199', boxShadow: '0 0 50px rgba(253,133,103,0.8)' });
    cue(A, 'impact', { gain: 1.0, big: true });
    cue(T.url - 0.05, 'shimmer', { gain: 0.6 });
    cue(T.url + 0.9, 'tick', { gain: 0.4 });
    E.burst({ t: A, x: 960, y: 370, n: 160, speed: 1700, life: 1.5, size: 2.4, color: '#ffb199', drag: 2.4, seed: 71, kind: 'streak' });
    E.burst({ t: A, x: 960, y: 370, n: 70, speed: 600, life: 2.4, size: 3, color: '#fd8567', drag: 1.4, seed: 72, gravity: 60 });
  };
  S.update = (t) => {
    const dt = t - A;
    // the lockup slams in on the downbeat
    const k = EP(t, A - 0.35, A, 'power4.in');
    const WW = (S.ww = S.ww || wm.offsetWidth || 800) + 16;   // wordmark width
    const wk = EP(t, A + 0.15, A + 0.95, 'expo.inOut');
    css(lock, { left: `${-(MW + 36 + WW * wk) / 2}px` });
    css(wmask, { width: `${WW * wk}px` });
    tf(wm, `translateX(${(1 - wk) * -200}px)`);
    tf(lock, `translateZ(${(1 - k) * 1800}px) scale(${1 + 0.08 * Math.exp(-Math.max(0, dt) * 6) * (dt > 0 ? 1 : 0)})`);
    op(lock, P(t, A - 0.35, A - 0.25));
    op(shock, dt > 0 ? Math.max(0, 1 - dt / 0.8) : 0);
    tf(shock, `scale(${0.15 + 2.4 * EP(t, A, A + 0.8, 'expo.out')})`);
    op(halo, P(t, A, A + 0.6) * (0.8 + 0.2 * Math.sin(t * 1.3)));
    // tagline, url, install
    tagW.forEach((w, i) => tf(w, `translateY(${(1 - EP(t, A + 0.7 + i * 0.07, A + 1.3 + i * 0.07, 'expo.out')) * 110}%)`));
    urlC.forEach((c, i) => {
      const ck = EP(t, T.url - 0.1 + i * 0.035, T.url + 0.4 + i * 0.035, 'back.out(2.2)');
      op(c, P(t, T.url - 0.1 + i * 0.035, T.url + i * 0.035)); tf(c, `translateY(${(1 - ck) * 40}px) scale(${0.6 + 0.4 * ck})`);
    });
    const nk = EP(t, T.url + 0.8, T.url + 1.4, 'expo.out');
    tf(npm, `translateX(-50%) translateY(${(1 - nk) * 30}px)`); op(npm, nk);
    // slow drift
    const sk = E.shake(t, [[A, 1.6, 0.7]], 9);
    E.cam(world, { x: sk.x, y: -60 + sk.y, s: kf(t, [[A, 1.04], [Bn, 0.97, 'power1.out']]), rz: sk.r, ry: kf(t, [[A, 3], [Bn, -2]]) });
    op(world, P(t, A - 0.4, A - 0.3));
  };
  SCENES.push(S);
})();

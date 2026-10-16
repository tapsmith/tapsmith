// ─── Frame loop ───
// window.seekFrame(t) renders the exact frame for time t; render.mjs calls it
// once per sub-frame and screenshots the stage.
(function () {
  const { kf, P, clamp } = E;
  const scenesEl = document.getElementById('scenes');
  const backdrop = new E.Backdrop(document.getElementById('bg'));
  const grain = new E.Grain(document.getElementById('grain'));
  const fx = document.getElementById('fx').getContext('2d');
  const flash = document.getElementById('flash');
  const fade = document.getElementById('fade');

  for (const s of SCENES) {
    s.root = E.h('div', 'scene', scenesEl);
    s.root.id = 'sc-' + s.id;
    s.build(s.root);
  }

  // Global look: the backdrop's warmth/energy arc across the film.
  const B = TL.BEAT;
  function look(t) {
    return {
      t,
      warm: kf(t, [[0, 0.15], [1.5, 0.0], [B - 0.02, 0.0], [B + 0.4, 1, 'expo.out']]),
      energy: kf(t, [[0, 0.2], [14, 0.6], [15.9, 0.0, 'power2.in'], [B - 0.01, 0], [B + 0.2, 1, 'expo.out'], [B + 3, 0.55], [98, 0.6], [100, 0.95], [114, 0.95], [116.2, 1.0], [122, 0.5]]),
      glow: kf(t, [[0, 0.0], [1, 0.25], [14.5, 0.35], [15.9, 0.0, 'power2.in'], [16.8, 0.0], [B, 1.0, 'power3.in'], [B + 1.2, 0.55, 'power2.out'], [34, 0.45], [116, 0.5], [116.3, 1, 'expo.out'], [119, 0.7]]),
      grid: kf(t, [[0, 0], [B - 0.02, 0], [B + 0.5, 0.8, 'expo.out'], [33.5, 0.8], [34.5, 0.35], [97.5, 0.35], [98.5, 0.8], [115, 0.8], [116.5, 0.5]]),
      gx: 0.5, gy: kf(t, [[0, 0.5], [B, 0.45], [116, 0.42]]),
    };
  }
  // global flashes: [time, strength, color]
  const FLASHES = [[B, 1.0, '253,133,103'], [116.0, 0.9, '253,133,103']];

  window.seekFrame = async function (t) {
    const jobs = [];
    for (const s of SCENES) {
      const [a, b] = s.range;
      const on = t >= a && t < b;
      s.root.style.display = on ? '' : 'none';
      if (on) { const r = s.update(t); if (r && r.then) jobs.push(r); }
    }
    backdrop.draw(look(t));
    // particles
    fx.setTransform(1, 0, 0, 1, 0, 0);
    fx.clearRect(0, 0, 3840, 2160);
    fx.setTransform(2, 0, 0, 2, 0, 0);
    fx.globalCompositeOperation = 'lighter';
    E.drawParticles(fx, t);
    fx.globalCompositeOperation = 'source-over';
    // flash
    let fl = 0, col = '253,133,103';
    for (const [ft, st, c] of FLASHES) {
      const k = P(t, ft - 0.03, ft) * Math.exp(-Math.max(0, t - ft) * 5.5);
      if (k * st > fl) { fl = k * st; col = c; }
    }
    flash.style.background = `radial-gradient(ellipse at 50% 48%, rgba(${col},0.95) 0%, rgba(${col},0.35) 35%, rgba(${col},0) 75%)`;
    E.op(flash, fl);
    grain.draw(t, kf(t, [[0, 0.11], [15, 0.13], [B, 0.07], [124, 0.07]]));
    E.op(fade, clamp(P(t, 0, 0.6) < 1 ? 1 - P(t, 0, 0.6) : 0) + P(t, TL.DUR - 1.2, TL.DUR - 0.1));
    await Promise.all(jobs);
    return true;
  };

  window.filmReady = (async () => {
    await document.fonts.ready;
    await Promise.all(SCENES.flatMap((s) => s.ready || []));
    return true;
  })();
})();

// ─── Scene 2 · The turn (16–19.6 s) ───
// "Tapsmith is the next step." Out of the dark, the mark's three pieces arrive
// one per phrase and lock together on the downbeat; the score drops with it.
(function () {
  const { h, kf, P, EP, op, tf, css } = E;
  const BEAT = TL.BEAT;
  const MH = 300, MW = MH * 213 / 256;           // mark size
  const ARR = [W('2a', 'tapsmith'), W('2a', 'is'), W('2a', 'next')];
  // start pose per piece: x, y, z, rotX, rotY, rotZ
  const START = [[-760, -420, -1300, 70, -160, -40], [-640, 520, -1100, -80, 120, 60], [900, 260, -1200, 40, 200, -90]];
  const LOCK_X = -440;                            // mark's x in the final lockup
  ARR.forEach((a, i) => cue(a, 'shard', { i, gain: 0.5 + 0.15 * i }));
  cue(BEAT - 1.4, 'swell', { dur: 1.4, gain: 0.9 });
  cue(BEAT, 'impact', { gain: 1.0 });
  E.burst({ t: BEAT, x: 960, y: 540, n: 140, speed: 1500, life: 1.3, size: 2.4, color: '#ffb199', drag: 2.6, seed: 11, kind: 'streak' });
  E.burst({ t: BEAT, x: 960, y: 540, n: 60, speed: 700, life: 1.8, size: 3.2, color: '#fd8567', drag: 1.8, seed: 12 });

  const CSS = `
  #sc-turn .piece { position:absolute; left:${-MW / 2}px; top:${-MH / 2}px; filter: drop-shadow(0 0 26px rgba(253,133,103,0.75)); }
  #sc-turn .rays { position:absolute; left:-1100px; top:-1100px; width:2200px; height:2200px; border-radius:50%;
     background: repeating-conic-gradient(from 0deg, rgba(253,133,103,0.22) 0deg 2.2deg, rgba(253,133,103,0) 2.2deg 9deg);
     -webkit-mask: radial-gradient(circle, #000 0%, rgba(0,0,0,0.6) 25%, transparent 62%); }
  #sc-turn .shock { position:absolute; left:-400px; top:-400px; width:800px; height:800px; border-radius:50%; border:6px solid #ffb199;
     box-shadow: 0 0 40px rgba(253,133,103,0.8), inset 0 0 40px rgba(253,133,103,0.6); }
  #sc-turn .word { position:absolute; font-family:'Poppins',sans-serif; font-weight:500; font-size:214px; color:#f1ebe4; letter-spacing:-0.005em;
     line-height:1; white-space:nowrap; top:40px; }
  #sc-turn .wmask { position:absolute; overflow:hidden; top:-150px; height:300px; left:0; }
  `;
  h('style', '', document.head, CSS);

  const S = { id: 'turn', range: [15.8, 19.7] };
  let world, pieces, rays, shock, wmask, word, mark;
  S.build = (root) => {
    ({ world } = E.viewport(root));
    world.style.transformStyle = 'preserve-3d';
    rays = h('div', 'rays', world);
    shock = h('div', 'shock', world);
    mark = h('div', '', world); mark.style.transformStyle = 'preserve-3d';
    pieces = [0, 1, 2].map((i) => h('div', 'piece', mark, BRAND.pieceSVG(i, MH, i === 2 ? '#ff9779' : '#fd8567')));
    wmask = h('div', 'wmask', world);
    word = h('div', 'word', wmask, 'Tapsmith');
  };
  S.update = (t) => {
    // pieces converge, accelerating into the lock
    pieces.forEach((p, i) => {
      const a = ARR[i];
      const k = EP(t, a - 0.05, BEAT, 'power3.in');
      const [x, y, z, rx, ry, rz] = START[i].map((v) => v * (1 - k));
      op(p, P(t, a - 0.05, a + 0.25));
      // after the lock the glow relaxes
      const glow = t < BEAT ? 0.75 : 0.75 * Math.exp(-(t - BEAT) * 2.5) + 0.25;
      p.style.filter = `drop-shadow(0 0 ${18 + 30 * glow}px rgba(253,133,103,${glow.toFixed(3)})) brightness(${t < BEAT ? 1.15 : 1 + 0.9 * Math.exp(-(t - BEAT) * 6)})`;
      tf(p, `translate3d(${x}px, ${y}px, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg)`);
    });
    // the lockup: mark slides left, wordmark wipes out from behind it
    const lk = EP(t, BEAT + 0.12, BEAT + 0.85, 'expo.inOut');
    const mx = LOCK_X * lk;
    tf(mark, `translate3d(${mx}px, 0, 0) scale(${1 + 0.06 * Math.exp(-Math.max(0, t - BEAT) * 7) * (t >= BEAT ? 1 : 0)})`);
    const wl = mx + MW / 2 + 34;
    css(wmask, { left: `${wl}px`, width: `${960 * lk}px` });
    tf(word, `translateX(${(1 - lk) * -260}px)`);
    op(wmask, lk > 0 ? 1 : 0);
    // impact elements
    const dt = t - BEAT;
    op(rays, dt < 0 ? 0 : Math.exp(-dt * 1.6) * 0.9);
    tf(rays, `rotate(${dt * 9}deg) scale(${0.6 + 0.5 * EP(t, BEAT, BEAT + 1.2)})`);
    op(shock, dt < 0 ? 0 : Math.max(0, 1 - dt / 0.7));
    tf(shock, `scale(${0.2 + 2.6 * EP(t, BEAT, BEAT + 0.7, 'expo.out')})`);
    shock.style.borderWidth = `${Math.max(0.5, 8 * (1 - dt / 0.7))}px`;
    // camera: a slow push through the approach, a hit on the lock, then a
    // pull-back that hands over to the code scene
    const sk = E.shake(t, [[BEAT, 2.2, 0.7]], 21);
    const s = kf(t, [[15.8, 0.9], [BEAT, 1.08, 'power2.in'], [BEAT + 0.05, 1.0, 'expo.out'], [BEAT + 0.9, 0.98], [19.6, 0.55, 'power3.in']]);
    E.cam(world, { x: sk.x, y: sk.y + kf(t, [[BEAT + 0.9, 0], [19.6, -260, 'power3.in']]), s, rz: sk.r, rx: kf(t, [[BEAT + 0.9, 0], [19.6, 28, 'power3.in']]) });
    op(world, 1 - P(t, 18.9, 19.3));
  };
  SCENES.push(S);
})();

// ─── Brand assets & reusable set pieces ───
(function () {
  const B = (window.BRAND = {});
  // The Tapsmith mark, as its three pieces (head, left leg, right leg) so the
  // turn can assemble it. viewBox 0 0 213 256.
  B.MARK = [
    'M 11.48 22.33 C 9.25 17.50 12.60 11.05 17.98 10.49 C 24.18 10.14 30.01 12.83 35.99 14.02 C 66.76 20.77 97.38 28.19 128.06 35.31 C 141.50 37.95 154.68 41.75 168.07 44.64 C 170.87 45.08 173.21 46.74 175.45 48.36 C 181.25 65.26 187.66 81.94 193.43 98.83 C 194.64 101.62 195.89 104.50 195.43 107.62 C 192.96 107.83 190.47 107.83 188.07 107.15 C 178.40 104.74 168.53 103.20 158.87 100.73 C 148.28 98.08 137.41 96.73 126.94 93.62 C 126.60 93.88 125.92 94.40 125.58 94.66 C 125.27 94.86 124.66 95.25 124.35 95.45 C 124.49 94.71 124.63 93.97 124.76 93.23 C 111.54 91.01 98.48 87.93 85.23 85.85 C 69.77 81.91 53.66 85.18 38.01 82.87 C 34.91 82.32 31.34 81.02 30.29 77.71 C 23.98 59.27 17.98 40.71 11.48 22.33 Z',
    'M 77.60 137.56 C 79.44 135.25 81.85 133.48 84.00 131.48 C 85.18 131.79 86.36 132.11 87.54 132.42 C 86.89 135.34 86.74 138.42 88.29 141.11 C 86.48 140.47 84.67 139.86 82.84 139.27 C 84.24 143.44 86.40 147.34 89.47 150.53 C 92.42 153.63 94.05 157.65 95.44 161.63 C 97.54 167.71 101.58 172.82 104.37 178.57 C 106.31 182.58 108.12 186.67 110.68 190.34 C 114.16 195.34 116.38 201.07 119.84 206.08 C 121.65 208.41 121.62 211.40 121.64 214.19 C 108.58 224.22 96.19 235.07 83.45 245.48 C 81.96 247.13 79.67 246.60 77.71 246.62 C 76.97 245.82 76.22 245.03 75.47 244.24 C 75.11 211.83 76.11 179.41 75.83 147.00 C 75.90 143.82 75.71 140.30 77.60 137.56 Z',
    'M 110.93 106.99 C 115.32 103.06 119.13 98.35 124.35 95.45 C 124.66 95.25 125.27 94.86 125.58 94.66 C 127.12 103.01 125.77 111.54 126.18 119.98 C 125.26 148.98 125.72 178.02 125.60 207.03 C 125.67 209.98 123.54 212.21 121.64 214.19 C 121.62 211.40 121.65 208.41 119.84 206.08 C 116.38 201.07 114.16 195.34 110.68 190.34 C 108.12 186.67 106.31 182.58 104.37 178.57 C 101.58 172.82 97.54 167.71 95.44 161.63 C 94.05 157.65 92.42 153.63 89.47 150.53 C 86.40 147.34 84.24 143.44 82.84 139.27 C 84.67 139.86 86.48 140.47 88.29 141.11 C 86.74 138.42 86.89 135.34 87.54 132.42 C 86.36 132.11 85.18 131.79 84.00 131.48 C 93.12 123.47 101.68 114.85 110.93 106.99 Z',
  ];
  B.markSVG = (h, fills = ['#fd8567', '#fd8567', '#ff9779']) =>
    `<svg viewBox="0 0 213 256" height="${h}" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible">` +
    B.MARK.map((d, i) => `<path fill="${fills[i]}" d="${d}"/>`).join('') + '</svg>';
  // a single-piece svg (for animating the pieces independently)
  B.pieceSVG = (i, h, fill = '#fd8567') =>
    `<svg viewBox="0 0 213 256" height="${h}" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible"><path fill="${fill}" d="${B.MARK[i]}"/></svg>`;

  // ─── The test app's "API Calls" screen, rebuilt as vector HTML ───
  // (the same screen the e2e network-mocking test drives), for iOS and Android.
  const CSS = `
  .phone { position: absolute; width: 380px; height: 800px; border-radius: 62px; padding: 13px;
           background: linear-gradient(145deg, #4a4a4f, #1b1b1e 40%, #2c2c30); box-shadow: 0 60px 140px rgba(0,0,0,0.65), 0 0 0 1.5px #6a6a70 inset; }
  .phone.android { border-radius: 46px; background: linear-gradient(145deg, #3d3a47, #17161b 40%, #2a2833); }
  .phone .scr { position: relative; width: 100%; height: 100%; border-radius: 50px; overflow: hidden; background: #f3f3f5;
                font-family: 'Inter', sans-serif; color: #111; }
  .phone.android .scr { border-radius: 34px; }
  .scr .sb { height: 54px; display: flex; align-items: center; justify-content: space-between; padding: 0 30px 0 34px; font: 600 16px 'Inter'; background: #fff; }
  .phone.android .scr .sb { height: 40px; padding: 0 22px; font: 500 14px 'Inter'; }
  .scr .island { position: absolute; left: 50%; top: 11px; width: 112px; height: 33px; border-radius: 20px; background: #000; transform: translateX(-50%); }
  .scr .punch { position: absolute; left: 50%; top: 12px; width: 18px; height: 18px; border-radius: 50%; background: #111; transform: translateX(-50%); }
  .scr .nav { height: 46px; display: flex; align-items: center; justify-content: center; position: relative; background: #fff; font: 600 16px 'Inter';
              border-bottom: 1px solid #e6e6ea; }
  .scr .nav .back { position: absolute; left: 14px; color: #111; font: 400 16px 'Inter'; display: flex; align-items: center; gap: 4px;
                    background: #f1f1f3; border-radius: 16px; padding: 5px 12px 5px 8px; }
  .phone.android .scr .nav { justify-content: flex-start; padding-left: 64px; font: 500 21px 'Inter'; height: 60px; }
  .phone.android .scr .nav .back { background: none; left: 18px; font-size: 24px; padding: 0; }
  .scr .pbody { padding: 18px 18px; }
  .scr .sbi { display:flex; gap:4px; align-items:flex-end; } .scr .sbi i { display:block; width:5px; background:#111; border-radius:1px; }
  .scr .sbi i:nth-child(1){height:6px} .scr .sbi i:nth-child(2){height:9px} .scr .sbi i:nth-child(3){height:12px}
  .scr .item { display:flex; align-items:center; gap:12px; background:#fff; border-radius:14px; padding:12px; margin-bottom:10px; font:500 16px 'Inter'; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
  .scr .item b { margin-left:auto; font:600 16px 'Inter'; } .scr .item .sw { width:46px; height:46px; border-radius:10px; }
  .scr .lbl { font:600 14px 'Inter'; color:#666; margin:18px 2px 8px; text-transform:uppercase; letter-spacing:0.06em; }
  .scr .pc { display:flex; gap:8px; }
  .scr .field { flex:1; height:48px; border-radius:11px; background:#fff; border:2px solid #d9d9de; display:flex; align-items:center; padding:0 14px; font:500 17px 'JetBrains Mono',monospace; position:relative; }
  .scr .field .ph { color:#aaa; font:400 16px 'Inter'; position:absolute; left:14px; } .scr .field .fc { width:2px; height:22px; background:#0a7aff; margin-left:1px; }
  .scr .apply { flex:0 0 96px; height:48px; border-radius:11px; font-size:16px; }
  .scr .ok { margin-top:12px; display:inline-block; padding:8px 14px; border-radius:20px; background:#e3f6ea; color:#1a9b50; font:700 14px 'Inter'; }
  .scr .sum { display:flex; align-items:baseline; gap:10px; margin-top:18px; padding-top:16px; border-top:1px solid #e3e3e8; font:600 18px 'Inter'; }
  .scr .sum .was { margin-left:auto; color:#999; text-decoration:line-through; font:500 15px 'Inter'; } .scr .sum b { font:800 24px 'Inter'; }
  .scr .pay { margin-top:18px; height:54px; border-radius:14px; background:#111; font-size:17px; }
  .scr h3 { font: 700 26px 'Inter'; letter-spacing: -0.02em; }
  .scr .sub { font: 400 13px 'Inter'; color: #666; margin-top: 4px; }
  .scr .row { display: flex; gap: 8px; margin-top: 16px; }
  .scr .btn { flex: 1; height: 42px; border-radius: 9px; background: #0a7aff; color: #fff; font: 600 13.5px 'Inter';
              display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; }
  .scr .btn.red { background: #ff3b30; }
  .scr .btn.wide { margin-top: 10px; }
  .scr .btn .rip { position: absolute; left:0; top:0; width: 20px; height: 20px; border-radius: 50%; background: rgba(255,255,255,0.55); }
  .scr .sect { font: 600 18px 'Inter'; margin-top: 22px; }
  .scr .card { margin-top: 10px; background: #fff; border-radius: 12px; padding: 14px 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .scr .card b { font: 600 15px 'Inter'; display: block; }
  .scr .card span { font: 400 13px 'Inter'; color: #666; }
  .scr .spin { width: 22px; height: 22px; border: 3px solid #d0d0d6; border-top-color: #0a7aff; border-radius: 50%; margin: 18px auto 0; }
  .scr .hl { position: absolute; border: 2.5px solid #fd8567; border-radius: 8px; box-shadow: 0 0 0 4px rgba(253,133,103,0.2); }
  .scr .home { position: absolute; left: 50%; bottom: 8px; width: 130px; height: 5px; border-radius: 3px; background: #111; transform: translateX(-50%); }
  `;
  E.h('style', '', document.head, CSS);
  // A "Checkout" screen of the fictional acme shop the code scene's test drives:
  // type a promo code, tap Apply, see 20% off.
  B.Phone = class {
    constructor(parent, platform = 'ios') {
      this.platform = platform;
      const el = (this.el = E.h('div', 'phone ' + platform, parent));
      const scr = (this.scr = E.h('div', 'scr', el));
      const ios = platform === 'ios';
      scr.innerHTML = `
        <div class="sb"><span>9:41</span><span class="sbi"><i></i><i></i><i></i></span></div>
        ${ios ? '<div class="island"></div>' : '<div class="punch"></div>'}
        <div class="nav"><span class="back">${ios ? '‹ Cart' : '←'}</span><span>Checkout</span></div>
        <div class="pbody">
          <div class="item"><span class="sw" style="background:#d9c7b4"></span><span>Linen shirt</span><b>$64.00</b></div>
          <div class="item"><span class="sw" style="background:#8a9a7b"></span><span>Canvas tote</span><b>$38.00</b></div>
          <div class="lbl">Promo code</div>
          <div class="pc"><div class="field"><span class="ph">Enter code</span><span class="val"></span><span class="fc"></span></div><div class="btn apply">Apply<i class="rip"></i></div></div>
          <div class="ok">✓ LAUNCH20 · 20% off</div>
          <div class="sum"><span>Total</span><span class="was">$102.00</span><b class="tot">$102.00</b></div>
          <div class="btn pay">Pay now</div>
        </div>
        <div class="home"></div>`;
      const q = (c) => scr.querySelector(c);
      Object.assign(this, { rip: q('.rip'), val: q('.val'), ph: q('.ph'), fc: q('.fc'), field: q('.field'), ok: q('.ok'), was: q('.was'), tot: q('.tot'), apply: q('.apply') });
    }
    // typeAt: typing starts; tapAt: Apply tapped
    update(t, typeAt, tapAt) {
      const code = 'LAUNCH20';
      const n = Math.floor(code.length * E.P(t, typeAt, typeAt + 0.55));
      this.val.textContent = code.slice(0, n);
      E.op(this.ph, n ? 0 : 1);
      const focused = t >= typeAt - 0.1 && t < tapAt + 0.05;
      this.field.style.borderColor = focused ? '#0a7aff' : '#d9d9de';
      E.op(this.fc, focused && (t * 2) % 1 < 0.6 ? 1 : 0);
      const k = E.P(t, tapAt, tapAt + 0.45);
      E.op(this.rip, t >= tapAt && t < tapAt + 0.5 ? 1 - k : 0);
      E.tf(this.rip, `translate(30px, 12px) scale(${1 + 9 * E.ease('power2.out')(k)})`);
      E.tf(this.apply, `scale(${1 - 0.06 * Math.sin(Math.PI * E.P(t, tapAt, tapAt + 0.18))})`);
      const r = E.EP(t, tapAt + 0.22, tapAt + 0.6, 'back.out(2)');
      E.op(this.ok, Math.min(1, r * 1.4));
      E.tf(this.ok, `translateY(${(1 - r) * 10}px) scale(${0.9 + 0.1 * r})`);
      const done = t >= tapAt + 0.25;
      E.op(this.was, done ? 1 : 0);
      this.tot.textContent = done ? '$81.60' : '$102.00';
      this.tot.style.color = done ? '#1a9b50' : '#111';
    }
  };
})();

// ─── Engine: deterministic, random-access animation primitives ───
// Every visual is a pure function of time t, so any frame (or sub-frame, for
// motion blur) renders identically no matter which worker renders it or in
// what order. No tweens hold state; GSAP is used only for its easing curves.
(function () {
  const E = (window.E = {});
  gsap.registerPlugin(CustomEase);

  // ─── Math ───
  E.clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  E.lerp = (a, b, k) => a + (b - a) * k;
  E.P = (t, a, b) => E.clamp((t - a) / (b - a));                 // linear progress in [a,b]
  E.win = (t, a, b, fi = 0.3, fo = 0.3) => E.P(t, a, a + fi) * (1 - E.P(t, b - fo, b)); // fade window
  const easeCache = {};
  E.ease = (name) => {
    if (typeof name === 'function') return name;
    if (!easeCache[name]) easeCache[name] = gsap.parseEase(name || 'none');
    return easeCache[name];
  };
  // signature motion curves
  CustomEase.create('snap', 'M0,0 C0.12,0 0.08,1 1,1');           // fast in, long settle
  CustomEase.create('whip', 'M0,0 C0.7,0 0.3,1 1,1');             // camera whip: slow-fast-slow
  CustomEase.create('glide', 'M0,0 C0.25,0.1 0.15,1 1,1');
  E.EP = (t, a, b, ease = 'power3.out') => E.ease(ease)(E.P(t, a, b)); // eased progress

  // Keyframe track: keys = [[time, value, easeIntoThisKey?], ...]; values may be numbers or arrays.
  E.kf = (t, keys, defEase = 'power2.inOut') => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1, e1] = keys[i];
      if (t <= t1) {
        const [t0, v0] = keys[i - 1];
        const k = E.ease(e1 || defEase)((t - t0) / (t1 - t0 || 1));
        if (Array.isArray(v0)) return v0.map((a, j) => E.lerp(a, v1[j], k));
        return E.lerp(v0, v1, k);
      }
    }
    return keys[keys.length - 1][1];
  };

  // Seeded PRNG (mulberry32) and smooth value noise for shakes/drift
  E.rng = (seed) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  E.noise1 = (x, seed = 0) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return E.lerp(hash(i + seed * 1013), hash(i + 1 + seed * 1013), u) * 2 - 1;
  };
  // camera shake: decaying noise after each hit time
  E.shake = (t, hits, seed = 1) => {
    let x = 0, y = 0, r = 0;
    for (const [t0, amp, dur = 0.6] of hits) {
      if (t < t0 || t > t0 + dur) continue;
      const k = Math.pow(1 - (t - t0) / dur, 2) * amp;
      x += E.noise1(t * 38, seed) * k * 14;
      y += E.noise1(t * 41, seed + 7) * k * 10;
      r += E.noise1(t * 29, seed + 13) * k * 0.6;
    }
    return { x, y, r };
  };

  // ─── DOM ───
  E.h = (tag, cls, parent, html) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    if (parent) parent.appendChild(el);
    return el;
  };
  E.css = (el, o) => { for (const k in o) el.style[k] = o[k]; return el; };
  E.show = (el, on) => { el.style.display = on ? '' : 'none'; };
  E.op = (el, v) => { el.style.opacity = v <= 0.001 ? 0 : v >= 0.999 ? 1 : v.toFixed(4); el.style.visibility = v <= 0.001 ? 'hidden' : ''; };
  E.tf = (el, s) => { el.style.transform = s; };
  E.esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Split text into masked word/char spans for kinetic reveals.
  // Returns array of inner spans; each sits in an overflow-hidden mask.
  E.splitWords = (el, text, cls = '') => {
    el.innerHTML = '';
    return text.split(' ').map((w, i, arr) => {
      const m = E.h('span', 'mask', el);
      const inner = E.h('span', 'mask-in ' + cls, m, E.esc(w));
      if (i < arr.length - 1) el.appendChild(document.createTextNode(' '));
      return inner;
    });
  };
  E.splitChars = (el, text) => {
    el.innerHTML = '';
    return [...text].map((c) => E.h('span', 'ch', el, c === ' ' ? '&nbsp;' : E.esc(c)));
  };

  // ─── Code ───
  // Tiny display highlighter for TS / YAML / shell lines (not a parser).
  const KW = /\b(import|from|await|async|const|let|return|export|default|function|new|if|true|false|null)\b/;
  E.hl = (line, lang = 'ts') => {
    if (lang === 'yaml') {
      return E.esc(line)
        .replace(/^(\s*-\s*)?([A-Za-z]+:)/, (m, d = '', k) => `${d}<span class='c-key'>${k}</span>`)
        .replace(/"(.*?)"/g, `<span class='c-str'>"$1"</span>`)
        .replace(/^(---)$/, `<span class='c-cm'>$1</span>`);
    }
    if (lang === 'sh') {
      return E.esc(line).replace(/^(\$)/, '<span class="c-ps">$1</span>');
    }
    // tokenise: strings, comments, words, other
    const out = [];
    const re = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|([A-Za-z_$][\w$]*)|(\d+)|(\s+)|(.)/g;
    let m;
    while ((m = re.exec(line))) {
      const [tok, cm, str, word, num] = m;
      if (cm) out.push(`<span class="c-cm">${E.esc(cm)}</span>`);
      else if (str) out.push(`<span class="c-str">${E.esc(str)}</span>`);
      else if (word) {
        const next = line.slice(re.lastIndex).match(/^\s*\(/);
        if (KW.test(word) && KW.exec(word)[0] === word) out.push(`<span class="c-kw">${word}</span>`);
        else if (next) out.push(`<span class="c-fn">${word}</span>`);
        else out.push(word);
      } else if (num) out.push(`<span class="c-num">${num}</span>`);
      else out.push(E.esc(tok));
    }
    return out.join('');
  };
  // Typing: highlight the first n chars of a line (re-highlights the prefix so
  // partial tokens colour correctly once complete).
  E.typed = (line, n, lang) => E.hl(line.slice(0, Math.max(0, Math.floor(n))), lang);
  E.caret = (t, on = true) => (on && (t * 2.2) % 1 < 0.6 ? '<span class="caret"></span>' : '<span class="caret off"></span>');

  // ─── Camera ───
  // A scene's world div sits at stage centre inside a perspective container.
  // cam: x,y = world point at screen centre; s = apparent scale of the z=0 plane;
  // rx/ry/rz = orbit (deg) about that point.
  E.PERSP = 2400;
  E.cam = (world, c) => {
    const s = c.s ?? 1;
    const dz = E.PERSP * (1 - 1 / s);
    world.style.transform =
      `translateZ(${dz.toFixed(2)}px) rotateX(${(c.rx || 0).toFixed(3)}deg) rotateY(${(c.ry || 0).toFixed(3)}deg) ` +
      `rotateZ(${(c.rz || 0).toFixed(3)}deg) translate3d(${(-(c.x || 0)).toFixed(2)}px, ${(-(c.y || 0)).toFixed(2)}px, 0)`;
  };
  // Builds a viewport (perspective box) + world inside a scene root.
  E.viewport = (root) => {
    const vp = E.h('div', 'vp', root);
    const world = E.h('div', 'world', vp);
    return { vp, world };
  };
  E.place = (el, x, y, z = 0, extra = '') => {
    el.style.transform = `translate3d(${x}px, ${y}px, ${z}px) ${extra}`;
  };

  // ─── Video footage ───
  // A clip is shown at 1600x1000 CSS px (its 3200x2000 source = DSF 2 of the
  // recorded 1600x1000 viewport). seek(clipT) shows the clip frame nearest clipT
  // and positions the SOURCE-row path patches for that frame.
  E.Footage = class {
    constructor(parent, src, { patches = null, chrome = 'localhost:4830 · Tapsmith UI Mode' } = {}) {
      this.el = E.h('div', 'win footage', parent);
      if (chrome) {
        const bar = E.h('div', 'win-bar', this.el);
        bar.innerHTML = '<i></i><i></i><i></i>' + (chrome ? `<span class="url">${chrome}</span>` : '');
      }
      this.body = E.h('div', 'footage-body', this.el);
      this.v = E.h('video', '', this.body);
      this.v.muted = true; this.v.preload = 'auto'; this.v.src = src;
      this.patches = patches;
      this.pEls = [0, 1].map(() => E.h('div', 'src-patch', this.body));
      this.ready = new Promise((r) => {
        if (this.v.readyState >= 2) r();
        else this.v.addEventListener('loadeddata', r, { once: true });
      });
      this.frame = -1;
    }
    seek(clipT) {
      const f = Math.max(0, Math.round(clipT * 30));
      // patches: windows generated per clip frame (1920x1200 clip coords), dilated
      // by a frame each side so an off-by-one frame pick can never leak a path
      const runs = (this.patches || []).filter((r) => f >= r.f0 - 1 && f <= r.f1 + 1);
      const k = 1600 / 1920;
      this.pEls.forEach((p, i) => {
        const r = runs[i];
        if (!r) { p.style.display = 'none'; return; }
        p.style.display = 'flex';
        p.style.top = `${r.y0 * k - 1}px`;
        p.style.height = `${(r.y1 - r.y0) * k + 2}px`;
        p.textContent = r.text;
      });
      if (f === this.frame) return Promise.resolve();
      this.frame = f;
      const v = this.v;
      const target = Math.min((f + 0.5) / 30, Math.max(0, v.duration - 0.02));
      return new Promise((resolve) => {
        if (Math.abs(v.currentTime - target) < 1e-4) return resolve();
        const done = () => { v.removeEventListener('seeked', done); resolve(); };
        v.addEventListener('seeked', done);
        v.currentTime = target;
        setTimeout(done, 3000);
      });
    }
  };
  // Piecewise-linear time remap [[sceneT, clipT], ...] for speed ramps / jump cuts.
  E.remap = (t, map) => {
    if (t <= map[0][0]) return map[0][1];
    for (let i = 1; i < map.length; i++) {
      const [a0, b0] = map[i - 1], [a1, b1] = map[i];
      if (a1 === a0) continue;          // hard jump
      if (t <= a1) return E.lerp(b0, b1, (t - a0) / (a1 - a0));
    }
    return map[map.length - 1][1];
  };

  // ─── Particles (analytic, drawn on the fx canvas in screen space) ───
  E.bursts = [];
  E.burst = (o) => { E.bursts.push(o); return o; };
  // o: {t, x, y, n, speed, spread, angle, life, size, color, gravity, seed, drag, kind}
  E.drawParticles = (ctx, t) => {
    for (const b of E.bursts) {
      const life = b.life || 1.2;
      if (t < b.t || t > b.t + life + 0.6) continue;
      const r = E.rng(b.seed || 1);
      for (let i = 0; i < b.n; i++) {
        const ang = (b.angle ?? 0) + (r() - 0.5) * (b.spread ?? Math.PI * 2);
        const sp = (b.speed || 600) * (0.25 + 0.75 * r());
        const l = life * (0.5 + 0.5 * r());
        const dt = t - b.t - (b.stagger || 0) * r();
        if (dt < 0 || dt > l) continue;
        const drag = b.drag ?? 2.2;
        const d = (1 - Math.exp(-drag * dt)) / drag;            // integrated drag
        const x = b.x + Math.cos(ang) * sp * d + (b.ox || 0) * (r() - 0.5);
        const y = b.y + Math.sin(ang) * sp * d + 0.5 * (b.gravity || 0) * dt * dt + (b.oy || 0) * (r() - 0.5);
        const fade = Math.pow(1 - dt / l, 1.6);
        const size = (b.size || 3) * (0.5 + r()) * (b.shrink ? fade : 1);
        ctx.globalAlpha = fade * (b.alpha ?? 1);
        ctx.fillStyle = b.color || '#fd8567';
        if (b.kind === 'streak') {
          const vx = Math.cos(ang) * sp * Math.exp(-drag * dt), vy = Math.sin(ang) * sp * Math.exp(-drag * dt);
          ctx.strokeStyle = b.color || '#fd8567';
          ctx.lineWidth = size;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - vx * 0.03, y - vy * 0.03); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  };

  // ─── WebGL backdrop + grain ───
  function glProgram(gl, fs) {
    const vs = '#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0,1);}';
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(pr); gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    return pr;
  }
  const BG_FS = `#version 300 es
precision highp float;
uniform float t, warm, energy, glow, grid, cold;
uniform vec2 gpos, res;
out vec4 o;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return s;}
void main(){
  vec2 uv=gl_FragCoord.xy/res; uv.y=1.-uv.y;
  vec2 q=(uv-.5)*vec2(res.x/res.y,1.);
  // slow domain-warped smoke
  vec2 w=vec2(fbm(q*1.6+vec2(t*.035,-t*.02)),fbm(q*1.6+vec2(-t*.025,t*.03)+5.2));
  float s=fbm(q*1.3+w*1.4+vec2(0.,t*.015));
  vec3 baseW=vec3(.052,.040,.034), hiW=vec3(.36,.13,.07);
  vec3 baseC=vec3(.030,.036,.046), hiC=vec3(.10,.13,.17);
  vec3 base=mix(baseC,baseW,warm), hi=mix(hiC,hiW,warm);
  vec3 col=base+hi*smoothstep(.42,.95,s)*(.35+.65*energy)*.55;
  // key glow
  float d=length((uv-gpos)*vec2(res.x/res.y,1.));
  col+=mix(vec3(.25,.32,.42),vec3(.99,.52,.40),warm)*glow*exp(-d*d*3.2)*.55;
  // perspective dot-grid floor
  if(grid>0.){
    float hy=.56; float fy=uv.y-hy;
    if(fy>0.){
      float z=.12/fy; vec2 g=vec2((uv.x-.5)*z*2.2, z + t*.25);
      vec2 cell=fract(g*3.)-.5; float dot=smoothstep(.07,.0,length(cell)*(1.+z*.2));
      float fade=smoothstep(0.,.25,fy)*exp(-z*.18);
      col+=mix(vec3(.5,.6,.7),vec3(.99,.6,.45),warm)*dot*fade*grid*.22;
    }
  }
  // vignette
  float v=smoothstep(1.25,.25,length((uv-.5)*vec2(1.15,1.35)));
  col*=mix(.45,1.,v);
  o=vec4(col,1.);
}`;
  const GRAIN_FS = `#version 300 es
precision highp float;
uniform float t, amt; uniform vec2 res;
out vec4 o;
float h(vec3 p){p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yxz+33.33);return fract((p.x+p.y)*p.z);}
void main(){
  float g=h(vec3(gl_FragCoord.xy,floor(t*30.)*1.37))-.5;
  o=vec4(vec3(.5+g*amt),1.);
}`;
  E.Backdrop = class {
    constructor(canvas) {
      const gl = (this.gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false }));
      this.pr = glProgram(gl, BG_FS);
      this.u = {};
      for (const k of ['t', 'warm', 'energy', 'glow', 'grid', 'cold', 'gpos', 'res']) this.u[k] = gl.getUniformLocation(this.pr, k);
      this.w = canvas.width; this.hgt = canvas.height;
    }
    draw(p) {
      const gl = this.gl, u = this.u;
      gl.viewport(0, 0, this.w, this.hgt);
      gl.uniform1f(u.t, p.t); gl.uniform1f(u.warm, p.warm); gl.uniform1f(u.energy, p.energy);
      gl.uniform1f(u.glow, p.glow); gl.uniform1f(u.grid, p.grid); gl.uniform1f(u.cold, 0);
      gl.uniform2f(u.gpos, p.gx, p.gy); gl.uniform2f(u.res, this.w, this.hgt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  };
  E.Grain = class {
    constructor(canvas) {
      const gl = (this.gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false }));
      this.pr = glProgram(gl, GRAIN_FS);
      this.u = { t: gl.getUniformLocation(this.pr, 't'), amt: gl.getUniformLocation(this.pr, 'amt'), res: gl.getUniformLocation(this.pr, 'res') };
      this.w = canvas.width; this.hgt = canvas.height;
    }
    draw(t, amt) {
      const gl = this.gl;
      gl.viewport(0, 0, this.w, this.hgt);
      gl.uniform1f(this.u.t, t); gl.uniform1f(this.u.amt, amt); gl.uniform2f(this.u.res, this.w, this.hgt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  };
})();

// ─── Chapter card (screen-space lower-left title for each product chapter) ───
(function () {
  const E = window.E;
  E.Chapter = class {
    constructor(root, num, title) {
      this.el = E.h('div', 'chap', root);
      this.el.innerHTML = `<div class="chap-num">${num}</div><div class="chap-ttl"><span class="mask"><span class="mask-in">${title}</span></span></div><div class="chap-rule"></div>`;
      this.ttl = this.el.querySelector('.mask-in');
      this.num = this.el.querySelector('.chap-num');
      this.rule = this.el.querySelector('.chap-rule');
    }
    update(t, a, b) {
      const k = E.EP(t, a, a + 0.7, 'expo.out'), o = E.EP(t, b - 0.4, b, 'power2.in');
      E.op(this.el, (t >= a ? 1 : 0) * (1 - o));
      E.tf(this.ttl, `translateY(${(1 - k) * 110 + o * -110}%)`);
      E.tf(this.rule, `scaleX(${E.EP(t, a + 0.1, a + 0.9, 'expo.out')})`);
      E.op(this.num, E.P(t, a, a + 0.3));
    }
  };
})();

// Keep a zoomed camera inside a 1600x1000 footage body (+chrome bar above it):
// once the window fills the frame, never reveal its edges.
window.E.clampFocus = (fx, fy, s, bar = 40) => {
  if (s * 1600 <= 1920) return [fx, fy];
  const hx = 960 / s, hy = 540 / s;
  const cx = Math.min(Math.max(fx, hx), 1600 - hx);
  const cy = s * 1040 > 1080 ? Math.min(Math.max(fy, hy - bar), 1000 - hy) : fy;
  // blend in as the scale crosses the fill threshold so the clamp never pops
  const k = window.E.clamp((s * 1600 - 1920) / 200);
  return [window.E.lerp(fx, cx, k), window.E.lerp(fy, cy, k)];
};

// Render film/index.html. Usage (from tools/promo):
//   node film/render.mjs probe 2.5 9 18.2          QC stills -> film/probe/
//   node film/render.mjs strip 0 16 0.5            contact sheet of a range -> film/probe/strip-<a>-<b>.jpg
//   node film/render.mjs cues                      sound cue sheet -> film/cues.json
//   node film/render.mjs full [--sub 5] [--workers 5] [--dsf 2] [--from f] [--to f] [--out film/frames]
// `full` renders each 30 fps frame as `sub` sub-frames spread over a 180° shutter
// and averages them (true motion blur), at `dsf` supersampling, downscaled to 1080p.
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const MODE = argv[0] || 'probe';
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(p).size;
  const type = TYPES[path.extname(p)] || 'application/octet-stream';
  const m = (req.headers.range || '').match(/bytes=(\d+)-(\d*)/);
  if (m) {
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(p, { start: a, end: b }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(p).pipe(res);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/film/index.html`;

async function openPage(dsf) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--enable-gpu',
           ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
           ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])],
    protocolTimeout: 600000,
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.error('console:', m.text()); });
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: dsf });
  await page.goto(URL_, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.evaluate(() => window.filmReady);
  return { browser, page };
}
const shot = (page, t, type = 'jpeg', quality = 95) =>
  page.evaluate((t) => window.seekFrame(t), t).then(() => page.screenshot({ type, quality, optimizeForSpeed: true }));

const FPS = 30;
const PROBE = path.join(ROOT, 'film/probe');
fs.mkdirSync(PROBE, { recursive: true });

if (MODE === 'probe') {
  const { browser, page } = await openPage(Number(opt('dsf', 1)));
  for (const a of argv.slice(1).filter((x) => !x.startsWith('--') && !isNaN(Number(x)))) {
    const buf = await shot(page, Number(a));
    fs.writeFileSync(path.join(PROBE, `p-${a}.jpg`), buf);
    console.log('probe', a);
  }
  await browser.close();
} else if (MODE === 'strip') {
  const [a, b, step] = argv.slice(1, 4).map(Number);
  const { browser, page } = await openPage(1);
  const tiles = [];
  for (let t = a; t <= b + 1e-6; t += step) {
    const buf = await shot(page, +t.toFixed(3));
    tiles.push(await sharp(buf).resize(640, 360).jpeg({ quality: 85 }).toBuffer());
  }
  const cols = 4, rows = Math.ceil(tiles.length / cols);
  const out = sharp({ create: { width: cols * 640, height: rows * 360, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * 640, top: Math.floor(i / cols) * 360 })));
  const f = path.join(PROBE, `strip-${a}-${b}.jpg`);
  await out.jpeg({ quality: 85 }).toFile(f);
  console.log(f, tiles.length, 'tiles');
  await browser.close();
} else if (MODE === 'cues') {
  const { browser, page } = await openPage(1);
  const cues = await page.evaluate(() => ({ TL: window.TL, cues: window.CUES.sort((a, b) => a.t - b.t) }));
  fs.writeFileSync(path.join(ROOT, 'film/cues.json'), JSON.stringify(cues, null, 1));
  console.log('cues', cues.cues.length);
  await browser.close();
} else if (MODE === 'full') {
  const SUB = Number(opt('sub', 5)), W = Number(opt('workers', 5)), DSF = Number(opt('dsf', 2));
  const SHUTTER = Number(opt('shutter', 0.5));     // fraction of the frame interval the shutter is open
  const OUT = path.resolve(ROOT, opt('out', 'film/frames'));
  fs.mkdirSync(OUT, { recursive: true });
  const DUR = Number(opt('dur', 124));
  const from = Number(opt('from', 0)), to = Math.min(Number(opt('to', Math.round(DUR * FPS))), Math.round(DUR * FPS));
  const skip = argv.includes('--resume');
  const frames = [];
  for (let f = from; f < to; f++) if (!(skip && fs.existsSync(path.join(OUT, `f${String(f).padStart(5, '0')}.jpg`)))) frames.push(f);
  const W_ = 1920 * DSF, H_ = 1080 * DSF;
  const t0 = Date.now();
  let done = 0;
  const stats = {};
  const chunk = Math.ceil(frames.length / W);
  await Promise.all([...Array(W)].map(async (_, w) => {
    const mine = frames.slice(w * chunk, (w + 1) * chunk);
    if (!mine.length) return;
    const { browser, page } = await openPage(DSF);
    const acc = new Uint32Array(W_ * H_ * 3);
    const raw = async (t) => (await sharp(await shot(page, t, 'jpeg', 96)).removeAlpha().raw().toBuffer());
    const small = (buf) => sharp(buf, { raw: { width: W_, height: H_, channels: 3 } }).resize(192, 108).greyscale().raw().toBuffer();
    for (const f of mine) {
      acc.fill(0);
      // adaptive sampling: render the shutter's two edges, measure how far the
      // picture moved between them, and spend more sub-frames where it did
      const tAt = (u) => (f + 0.5 + (u - 0.5) * SHUTTER) / FPS;
      const e0 = await raw(tAt(0)), e1 = await raw(tAt(1));
      const [s0, s1] = await Promise.all([small(e0), small(e1)]);
      let diff = 0;
      for (let i = 0; i < s0.length; i++) diff += Math.abs(s0[i] - s1[i]);
      diff /= s0.length;
      const K = SUB === 1 ? 1 : diff < 0.6 ? 2 : diff < 2.5 ? 6 : diff < 6 ? 12 : 24;
      const bufs = [e0];
      for (let k = 1; k < K - 1; k++) bufs.push(await raw(tAt(k / (K - 1))));
      if (K > 1) bufs.push(e1);
      for (const data of bufs) for (let i = 0; i < data.length; i++) acc[i] += data[i];
      const SUBN = bufs.length;
      stats[K] = (stats[K] || 0) + 1;
      const px = Buffer.alloc(W_ * H_ * 3);
      for (let i = 0; i < px.length; i++) px[i] = (acc[i] + (SUBN >> 1)) / SUBN;
      await sharp(px, { raw: { width: W_, height: H_, channels: 3 } })
        .resize(1920, 1080, { kernel: 'lanczos3' })
        .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
        .toFile(path.join(OUT, `f${String(f).padStart(5, '0')}.jpg`));
      if (++done % 60 === 0) {
        const s = (Date.now() - t0) / 1000;
        console.log(JSON.stringify(stats), `${done}/${frames.length} frames · ${s.toFixed(0)}s · eta ${((frames.length - done) * s / done / 60).toFixed(1)} min`);
      }
    }
    await browser.close();
  }));
  console.log('rendered', frames.length, 'frames in', ((Date.now() - t0) / 60000).toFixed(1), 'min');
}
server.close();
process.exit(0);

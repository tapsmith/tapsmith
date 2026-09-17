// Record the selector playground: after a warm run leaves the app on the API
// Calls screen, toggle pick mode on the live mirror, hover elements (green
// highlight), pick one, and let the Locator tab fill with generated selectors
// and purple match highlights. Frames land in pick-frames/.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const OUT = 'pick-frames';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  timeout: 120000,
  args: ['--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=2',
         '--user-data-dir=/tmp/promo-chrome-profile', '--no-default-browser-check'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:4830/', { waitUntil: 'networkidle2' });
await page.evaluate(() => { localStorage.setItem('tapsmith-mcp-panel', 'false'); });
await page.reload({ waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 3000));

await page.evaluate(() => {
  const c = document.createElement('div');
  c.id = '__cursor';
  c.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;pointer-events:none;z-index:2147483647;transition:transform 0.06s linear;will-change:transform;';
  c.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5.5 3.2v16.2l4.1-4.0 2.3 5.4 2.7-1.2-2.3-5.3 5.6-0.6z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  document.body.appendChild(c);
  let x = 800, y = 500;
  c.style.transform = `translate(${x}px, ${y}px)`;
  document.addEventListener('mousemove', (e) => {
    x = e.clientX; y = e.clientY;
    c.style.transform = `translate(${x}px, ${y}px)`;
  }, true);
  document.addEventListener('mousedown', () => {
    const p = document.createElement('div');
    p.style.cssText = `position:fixed;left:${x - 18}px;top:${y - 18}px;width:36px;height:36px;border-radius:50%;background:rgba(232,145,75,0.35);border:2px solid rgba(232,145,75,0.7);pointer-events:none;z-index:2147483646;animation:__pulse 0.45s ease-out forwards;`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 500);
  }, true);
  const st = document.createElement('style');
  st.textContent = '@keyframes __pulse { from { transform: scale(0.4); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }';
  document.head.appendChild(st);
});

const cdp = await page.createCDPSession();
let n = 0;
const meta = [];
cdp.on('Page.screencastFrame', async (f) => {
  const idx = n++;
  fs.writeFileSync(`${OUT}/f${String(idx).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64'));
  meta.push({ idx, t: f.metadata.timestamp });
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* ended */ }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mouse = page.mouse;
let cur = { x: 800, y: 500 };
const marks = {};
const mark = (k) => { marks[k] = Date.now() / 1000; console.log('mark', k); };

async function glide(x, y, ms = 550) {
  const steps = Math.max(10, Math.round(ms / 22));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await mouse.move(cur.x + (x - cur.x) * e, cur.y + (y - cur.y) * e);
    await sleep(Math.max(8, ms / steps - 6));
  }
  cur = { x, y };
}
async function click() { await mouse.down(); await sleep(90); await mouse.up(); }
async function rectOf(sel, text) {
  return page.evaluate((sel, text) => {
    for (const el of document.querySelectorAll(sel)) {
      if (text && !(el.textContent || '').includes(text)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.x, top: r.y };
    }
    return null;
  }, sel, text);
}

// warm-up run (off camera): leaves the app on the API Calls screen with the
// error banner visible, and populates the test tree with a green result
const child = spawn('node', ['mcp-client.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
const childLines = [];
child.stdout.on('data', (d) => {
  for (const l of d.toString().split('\n')) if (l.trim()) { childLines.push(l.trim()); console.log('[client]', l.trim()); }
});
const waitChild = (prefix, timeoutMs = 300000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const hit = childLines.find(l => l.startsWith(prefix));
    if (hit) { clearInterval(iv); resolve(hit); }
    else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error(`timeout waiting for ${prefix}`)); }
  }, 100);
});
// UI mode prepares the device for the next run right after a run finishes
// (background app reset), which would put the app back on the home screen
// before we can pick anything. Turn that preference off for this take.
async function setPrepareBetweenRuns(on) {
  const chip = await rectOf('.rc-device-actionable');
  if (!chip) { console.error('worker chip not found'); return; }
  await mouse.click(chip.x, chip.y, { button: 'right' });
  await sleep(400);
  const state = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.rc-context-item')].find((b) => (b.textContent || '').includes('Prepare device between runs'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { checked: el.getAttribute('aria-checked') === 'true', x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!state) { console.error('prepare toggle not found'); await page.keyboard.press('Escape'); return; }
  if (state.checked !== on) { await mouse.click(state.x, state.y); } else { await page.keyboard.press('Escape'); }
  await sleep(500);
  console.log('prepare between runs ->', on);
}
await setPrepareBetweenRuns(false);

if (!process.env.SKIP_RUN) {
  child.stdin.write('connect\n');
  await waitChild('connected');
  child.stdin.write('run\n');
  const runResult = await waitChild('done:run');
  if (!runResult.includes('All tests passed')) { console.error('warm-up run failed:', runResult); process.exit(1); }
  child.stdin.write('quit\n');
  await sleep(2500);
} else { child.stdin.write('quit\n'); }

// filter the tree so the left column shows the relevant file
const search = await rectOf('.te-search');
await glide(search.x, search.y, 500); await click();
for (const ch of 'api error') { await page.keyboard.type(ch); await sleep(50); }
await sleep(1200);

await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 });
await sleep(600);
mark('start');

// 1. Toggle pick mode from the mirror header
const pick = await rectOf('.mirror-pick-toggle');
if (!pick) { console.error('pick toggle not found'); await page.screenshot({ path: 'pick-debug.png' }); process.exit(1); }
await glide(pick.x, pick.y, 800); await click();
mark('pickOn');
await sleep(900);

// 2. Hover across app elements on the mirror — green highlight tracks them.
// Mirror canvas geometry: find the device frame canvas.
// Mirror canvas geometry: the device screen canvas specifically (in pick mode
// the overlay adds another canvas). Fractions are of the 402x874pt screen;
// recalibrate with probe-pick.mjs if the API Calls layout changes.
// The rail grows a status row for a moment after a run finishes, shifting the
// mirror column ~27px, so the rect is re-read right before every hover.
async function hoverScreen(fx, fy, ms) {
  const canvas = await rectOf('.dm-canvas');
  if (!canvas) { console.error('mirror canvas not found'); process.exit(1); }
  console.log('canvas rect', JSON.stringify(canvas));
  await glide(canvas.left + canvas.w * fx, canvas.top + canvas.h * fy, ms);
}
await hoverScreen(0.18, 0.265, 900);   // "Fetch Posts" button
await sleep(950);
mark('hover1');
await hoverScreen(0.50, 0.391, 800);   // error banner
await sleep(950);
await hoverScreen(0.815, 0.265, 800);  // "Fetch 404" button
await sleep(1000);
mark('hover2');

// 3. Pick it — Locator tab opens with generated selectors + purple matches
await click();
mark('picked');
await sleep(2600);

// 4. Click the second suggested option to show live re-matching
const opts = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.st-option')) {
    const r = el.getBoundingClientRect();
    if (r.width > 4) out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.textContent || '').slice(0, 60) });
  }
  return out;
});
console.log('options:', JSON.stringify(opts));
if (opts[1]) { await glide(opts[1].x, opts[1].y, 800); await click(); await sleep(2000); }
mark('optionClicked');
if (opts[0]) { await glide(opts[0].x, opts[0].y, 600); await click(); await sleep(1600); }
mark('backToFirst');

// 5. Hover the input row (match count visible), then rest
const input = await rectOf('.st-input');
if (input) { await glide(input.x + 40, input.y, 700); }
await sleep(1600);
mark('end');

await cdp.send('Page.stopScreencast');
await sleep(300);
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({ frames: meta, marks }));
console.log('frames:', n, 'marks:', JSON.stringify(marks));
await setPrepareBetweenRuns(true);
await browser.close();
process.exit(0);

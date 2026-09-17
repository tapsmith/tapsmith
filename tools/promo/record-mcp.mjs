// Record UI mode's MCP panel: a scripted "claude-code" client connects, lists
// tests, and runs api-error.test.ts live; the panel feed, test run, and device
// mirror are all real. Frames land in mcp-frames/ with timestamped meta.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const OUT = 'mcp-frames';
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
// generous MCP feed area, panel itself opened on camera
await page.evaluate(() => {
  localStorage.setItem('tapsmith-mcp-height', '330');
  localStorage.setItem('tapsmith-mcp-panel', 'false');
});
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
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 });

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

// scripted MCP client (spawned now, connects on 'connect' command)
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

mark('start');
await sleep(1500);

// 1. Filter to the agent-authored test file
const search = await rectOf('.te-search');
await glide(search.x, search.y, 600); await click();
mark('typing');
for (const ch of 'api error') { await page.keyboard.type(ch); await sleep(60); }
await sleep(1100);
const fileRow = await rectOf('.te-name', 'api-error.test.ts');
if (fileRow) { await glide(fileRow.x, fileRow.y, 600); await click(); await sleep(800); }
const suiteRow = await rectOf('.te-name', 'API error handling');
if (suiteRow && !(await rectOf('.te-name', 'posts API 500'))) {
  await glide(suiteRow.x, suiteRow.y, 450); await click(); await sleep(800);
}

// 2. Open the MCP panel from the top-bar chip (shows Listening + setup hint)
const chip = await rectOf('.rc-mcp-indicator');
if (!chip) { console.error('MCP chip not found'); await page.screenshot({ path: 'mcp-debug.png' }); process.exit(1); }
await glide(chip.x, chip.y, 700); await click();
mark('mcpOpened');
await sleep(2600);

// 3. Agent connects — pill flips from Listening to claude-code
child.stdin.write('connect\n');
await waitChild('connected');
mark('connected');
await sleep(1600);

// 4. list_tests
child.stdin.write('list\n');
await waitChild('done:list');
mark('listCalled');
await sleep(1800);

// 4b. snapshot — the agent reads the live screen (validated locators) before writing
child.stdin.write('snap\n');
await waitChild('done:snap');
mark('snapCalled');
await sleep(1800);

// 5. run_tests — the run streams in the main panel, mirror animates below
child.stdin.write('run\n');
mark('runStarted');
try {
  await page.waitForFunction(() => {
    const el = document.querySelector('.te-node.passed, .te-node .passed');
    if (el && (el.textContent || '').includes('posts API 500')) return true;
    return /1 passed|1 failed/.test(document.body.textContent || '');
  }, { timeout: 280000, polling: 500 });
} catch { console.error('run did not pass in time'); }
mark('passed');
await waitChild('done:run');
mark('runDone');
await sleep(1800);

// 6. Expand the run_tests feed entry to show the result summary
const entry = await rectOf('.mcp-entry', 'run_tests');
if (entry) { await glide(entry.x, entry.y, 650); await click(); await sleep(2400); }
mark('expanded');

await sleep(1400);
mark('end');

await cdp.send('Page.stopScreencast');
await sleep(300);
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({ frames: meta, marks }));
console.log('frames:', n, 'marks:', JSON.stringify(marks));
child.stdin.write('quit\n');
await browser.close();
process.exit(0);

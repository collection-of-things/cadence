// Before/after capture for the Cadence UI.
//   node capture.mjs <distDir> <outDir> [shots|video|all] [only=name,name]
// Screenshots every scenario at 1440x900 (plus narrow sizes) and records a
// walkthrough video with a drawn cursor, encoded with the system ffmpeg.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// the Cadence checkout (run from its root, or set CADENCE_REPO)
const R = process.env.CADENCE_REPO ?? process.cwd();
const HERE = new URL('.', import.meta.url).pathname;
const require = createRequire(join(R, 'package.json'));
const { _electron } = require('playwright-core');
const electronPath = require(join(R, 'apps/desktop/node_modules/electron'));

const [distArg, outArg, mode = 'all', onlyArg] = process.argv.slice(2);
const dist = resolve(distArg);
const out = resolve(outArg);
const only = onlyArg?.startsWith('only=') ? new Set(onlyArg.slice(5).split(',')) : null;
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(width, height, query = 'cadence_mock=1') {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [join(HERE, 'main.cjs'), `--dist=${dist}`, `--width=${width}`, `--height=${height}`, `--query=${query}`],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  await sleep(1200);
  return { app, page };
}

async function fresh(page) {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  await sleep(1400);
}

const btn = (page, name) => page.getByRole('button', { name, exact: true }).first();

// Move like a hand would, then act.
async function glide(page, locator, steps = 18) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps });
  return { x, y };
}
async function tap(page, locator, pause = 0) {
  await glide(page, locator);
  await sleep(120);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  if (pause) await sleep(pause);
}

/** name -> async (page) => void; leaves the page in the state to shoot. */
const scenarios = {
  '01-home': async () => {},
  '02-home-card-hover': async (p) => {
    await glide(p, p.locator('.poster-card, .square-card').first());
    await sleep(500);
  },
  '03-home-scrolled': async (p) => {
    await p.mouse.move(800, 500);
    await p.mouse.wheel(0, 600);
    await sleep(700);
  },
  '04-songs': async (p) => { await btn(p, 'Songs').click(); await sleep(900); },
  '05-songs-row-hover': async (p) => {
    await btn(p, 'Songs').click(); await sleep(900);
    await glide(p, p.locator('.track-row').nth(2));
    await sleep(400);
  },
  '06-songs-menu': async (p) => {
    await btn(p, 'Songs').click(); await sleep(900);
    const row = p.locator('.track-row').nth(2);
    await glide(p, row);
    await sleep(200);
    const more = row.locator('button[aria-haspopup], button[aria-label*="More" i], button[aria-label*="options" i]').first();
    if (await more.count()) { await more.click(); } else { await row.click({ button: 'right' }); }
    await sleep(500);
  },
  '07-albums': async (p) => { await btn(p, 'Albums').click(); await sleep(900); },
  '08-artists': async (p) => { await btn(p, 'Artists').click(); await sleep(900); },
  '09-album-detail': async (p) => {
    await p.getByRole('button', { name: /^Open Midnight Cartography/ }).first().click();
    await sleep(1100);
  },
  '10-album-detail-scrolled': async (p) => {
    await p.getByRole('button', { name: /^Open Midnight Cartography/ }).first().click();
    await sleep(900);
    await p.mouse.move(800, 500);
    await p.mouse.wheel(0, 500);
    await sleep(700);
  },
  '11-artist-detail': async (p) => {
    await btn(p, 'Artists').click(); await sleep(700);
    await p.locator('.artist-row').first().click();
    await sleep(1000);
  },
  '12-favourites': async (p) => { await btn(p, 'Favourite Songs').click(); await sleep(900); },
  '13-sources': async (p) => { await btn(p, 'Sources').click(); await sleep(900); },
  '14-search': async (p) => {
    const box = p.getByRole('searchbox').first();
    await box.click();
    await box.fill('glass');
    await sleep(300);
    await p.keyboard.press('Enter');
    await sleep(1000);
  },
  '15-queue': async (p) => { await btn(p, 'Queue').click(); await sleep(900); },
  '16-lyrics': async (p) => { await btn(p, 'Play').click(); await sleep(300); await btn(p, 'Lyrics').click(); await sleep(1400); },
  '17-now-playing': async (p) => { await btn(p, 'Play').click(); await sleep(200); await btn(p, 'Full screen player').click(); await sleep(1500); },
  '18-settings': async (p) => { await btn(p, 'Settings').click(); await sleep(900); },
  '19-settings-appearance': async (p) => {
    await btn(p, 'Settings').click(); await sleep(600);
    const a = p.getByRole('button', { name: /Appearance/ }).first();
    if (await a.count()) await a.click();
    await sleep(700);
  },
  '20-sidebar-hidden': async (p) => { await btn(p, 'Sidebar').click(); await sleep(900); },
  '21-apple-home': async (p) => { await p.getByRole('radio', { name: 'Apple Music' }).click(); await sleep(1500); },
  '22-play-on-menu': async (p) => { await btn(p, 'Play on').click(); await sleep(600); },
  '23-sidebar-row-hover': async (p) => { await glide(p, btn(p, 'Albums')); await sleep(400); },
  '24-search-focus': async (p) => { await p.getByRole('searchbox').first().click(); await sleep(500); },
  '25-songs-menu-bottom': async (p) => {
    await btn(p, 'Songs').click(); await sleep(900);
    const row = p.locator('.track-row').nth(9);
    await glide(p, row);
    await row.locator('.row-more').click();
    await sleep(500);
  },
  '26-empty-favourites': async (p) => { await btn(p, 'Favourite Songs').click(); await sleep(900); },
};

/** Narrow windows: [name, w, h, scenario] */
const narrow = [
  ['30-narrow-1100-home', 1100, 760, '01-home'],
  ['31-narrow-900-home', 900, 700, '01-home'],
  ['32-narrow-900-songs', 900, 700, '04-songs'],
  ['33-min-720-home', 720, 520, '01-home'],
  ['34-min-720-album', 720, 520, '09-album-detail'],
  ['35-narrow-1100-queue', 1100, 760, '15-queue'],
  ['36-wide-1920-home', 1920, 1080, '01-home'],
  ['37-narrow-900-queue', 900, 700, '15-queue'],
  ['38-narrow-900-lyrics', 900, 700, '16-lyrics'],
  ['39-mid-1040-queue', 1040, 740, '15-queue'],
];

async function shots() {
  const failures = [];
  const { app, page } = await launch(1440, 900);
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !only.has(name)) continue;
    try {
      await fresh(page);
      await fn(page);
      await page.screenshot({ path: join(out, `${name}.png`) });
      // horizontal overflow audit: any scroll container wider than itself
      const ox = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if (!/(auto|scroll)/.test(cs.overflowX)) continue;
          if (el.classList.contains('shelf-rail')) continue;
          if (el.scrollWidth > el.clientWidth + 1) bad.push(`${el.className || el.tagName} ${el.scrollWidth}>${el.clientWidth}`);
        }
        return bad;
      });
      if (ox.length) failures.push(`${name} h-overflow: ${ox.join(' | ')}`);
      console.log('shot', name);
    } catch (e) {
      failures.push(`${name}: ${e.message.split('\n')[0]}`);
      console.log('FAIL', name, e.message.split('\n')[0]);
    }
  }
  await app.close();
  for (const [name, w, h, base] of narrow) {
    if (only && !only.has(name)) continue;
    const s = await launch(w, h);
    try {
      await fresh(s.page);
      await scenarios[base](s.page);
      await s.page.screenshot({ path: join(out, `${name}.png`) });
      console.log('shot', name);
    } catch (e) {
      failures.push(`${name}: ${e.message.split('\n')[0]}`);
    }
    await s.app.close();
  }
  writeFileSync(join(out, 'audit.txt'), failures.join('\n') + '\n');
  console.log('audit:\n' + failures.join('\n'));
}

async function video() {
  const { app, page } = await launch(1440, 900);
  await fresh(page);
  // a drawn cursor, since the screencast has none
  await page.evaluate(() => {
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 0 1.5px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.5);pointer-events:none;transition:transform 90ms ease, background-color 90ms ease;';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(0.7)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
  });
  await page.mouse.move(720, 450);
  const cdp = await app.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ t: f.metadata.timestamp, d: f.data });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 });
  await sleep(800);

  // the walkthrough
  const cards = page.locator('.poster-card, .square-card');
  await glide(page, cards.nth(0)); await sleep(500);
  await glide(page, cards.nth(1)); await sleep(400);
  await glide(page, cards.nth(2)); await sleep(400);
  await page.mouse.wheel(0, 420); await sleep(900);
  await page.mouse.wheel(0, -420); await sleep(700);
  await tap(page, page.getByRole('button', { name: /^Open Midnight Cartography/ }).first(), 1200);
  await page.mouse.move(800, 600, { steps: 12 });
  await page.mouse.wheel(0, 360); await sleep(900);
  const row = page.locator('.track-row').nth(1);
  if (await row.count()) { await glide(page, row); await sleep(300); await row.dblclick(); await sleep(900); }
  await tap(page, btn(page, 'Queue'), 1100);
  await tap(page, btn(page, 'Lyrics'), 1400);
  await tap(page, btn(page, 'Lyrics'), 700);
  await tap(page, btn(page, 'Go back'), 1000);
  await tap(page, btn(page, 'Songs'), 900);
  const r3 = page.locator('.track-row').nth(3);
  await glide(page, r3); await sleep(300);
  await page.mouse.wheel(0, 500); await sleep(800);
  await tap(page, btn(page, 'Albums'), 900);
  await glide(page, page.locator('.album-card').nth(2)); await sleep(500);
  await tap(page, btn(page, 'Artists'), 900);
  await tap(page, btn(page, 'Full screen player'), 1800);
  await page.mouse.move(700, 400, { steps: 15 }); await sleep(800);
  await page.keyboard.press('Escape'); await sleep(1100);
  await tap(page, btn(page, 'Sidebar'), 900);
  await tap(page, btn(page, 'Sidebar'), 900);
  await tap(page, btn(page, 'Settings'), 1000);
  await tap(page, page.getByRole('radio', { name: 'Apple Music' }), 1500);
  await tap(page, page.getByRole('radio', { name: 'Local files' }), 1200);
  await sleep(500);

  await cdp.send('Page.stopScreencast');
  await app.close();
  encode(frames, join(out, 'walkthrough.mp4'));
}

function encode(frames, file) {
  const dir = join(out, '.frames');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let list = '';
  frames.forEach((f, i) => {
    const name = `f${String(i).padStart(5, '0')}.jpg`;
    writeFileSync(join(dir, name), Buffer.from(f.d, 'base64'));
    const next = frames[i + 1];
    const dur = next ? Math.max(0.001, next.t - f.t) : 0.5;
    list += `file '${name}'\nduration ${dur.toFixed(4)}\n`;
  });
  list += `file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'\n`;
  writeFileSync(join(dir, 'list.txt'), list);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
    '-vf', 'fps=30,scale=1440:-2:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-crf', '22', '-preset', 'medium', '-movflags', '+faststart', file], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) console.error(r.stderr);
  rmSync(dir, { recursive: true, force: true });
  console.log('video', file, frames.length, 'frames');
}

/** Worst-case names (?cadence_mock=worst): [name, w, h, scenario] */
const worst = [
  ['40-worst-home', 1440, 900, '01-home'],
  ['41-worst-songs', 1440, 900, '04-songs'],
  ['42-worst-album', 1440, 900, '09-album-detail-worst'],
  ['43-worst-queue', 1440, 900, '15-queue'],
  ['44-worst-now-playing', 1440, 900, '17-now-playing'],
  ['45-worst-player-900', 900, 700, '01-home'],
  ['46-worst-player-720', 720, 520, '01-home'],
  ['47-worst-artist', 1440, 900, '11-artist-detail'],
];
const worstOnly = {};
worstOnly['09-album-detail-worst'] = async (p) => {
  await p.getByRole('button', { name: /^Open An Extraordinarily/ }).first().click();
  await sleep(1100);
};

async function worstShots() {
  const failures = [];
  for (const [name, w, h, base] of worst) {
    if (only && !only.has(name)) continue;
    const s = await launch(w, h, 'cadence_mock=worst');
    try {
      await fresh(s.page);
      await (scenarios[base] ?? worstOnly[base])(s.page);
      await s.page.screenshot({ path: join(out, `${name}.png`) });
      const ox = await s.page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if (!/(auto|scroll)/.test(cs.overflowX) || el.classList.contains('shelf-rail')) continue;
          if (el.scrollWidth > el.clientWidth + 1) bad.push(`${el.className || el.tagName} ${el.scrollWidth}>${el.clientWidth}`);
        }
        return bad;
      });
      if (ox.length) failures.push(`${name} h-overflow: ${ox.join(' | ')}`);
      console.log('shot', name);
    } catch (e) {
      failures.push(`${name}: ${e.message.split('\n')[0]}`);
    }
    await s.app.close();
  }
  writeFileSync(join(out, 'audit-worst.txt'), failures.join('\n') + '\n');
  console.log('worst audit:\n' + failures.join('\n'));
}

/** Key transitions at quarter speed (DevTools playback rate), for judging motion frame by frame. */
async function motion() {
  const { app, page } = await launch(1440, 900);
  await fresh(page);
  const cdp = await app.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.25 });
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ t: f.metadata.timestamp, d: f.data });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });
  await page.mouse.move(720, 450);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  await sleep(600);
  await btn(page, 'Albums').click(); await sleep(1400);          // page change
  await btn(page, 'Queue').click(); await sleep(1600);           // side panel opens, stage slides
  await btn(page, 'Queue').click(); await sleep(1600);           // and closes
  await btn(page, 'Full screen player').click(); await sleep(2200); // Now Playing grows out of the card
  await page.keyboard.press('Escape'); await sleep(900);        // keyboard: instant by design
  await btn(page, 'Sidebar').click(); await sleep(1600);         // sidebar hides
  await btn(page, 'Sidebar').click(); await sleep(1600);         // and returns
  await page.getByRole('button', { name: /^Open Midnight Cartography/ }).first().click().catch(() => {});
  await btn(page, 'Home').click().catch(() => {}); await sleep(600);
  await page.getByRole('button', { name: /^Open Midnight Cartography/ }).first().click(); await sleep(1800); // album colour eases in
  await cdp.send('Page.stopScreencast');
  await app.close();
  encode(frames, join(out, 'motion-quarter-speed.mp4'));
}

if (mode === 'motion') await motion();
if (mode === 'shots' || mode === 'all') await shots();
if (mode === 'worst' || mode === 'all') await worstShots();
if (mode === 'video' || mode === 'all') await video();

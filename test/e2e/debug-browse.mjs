/** Debug: attach to the provider page target and call __cadenceCtl.amp raw. */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient, sleep, until } from './cdp.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');
const electronBin = join(desktopDir, 'node_modules', 'electron', 'dist', 'electron');
const CDP_PORT = '9334';
const profile = `/tmp/cadence-dbg-${process.pid}`;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.ELECTRON_DISABLE_SANDBOX = '1';
env.CADENCE_E2E_CDP_PORT = CDP_PORT;
env.CADENCE_USER_DATA = profile;
const app = spawn(electronBin, ['--no-sandbox', desktopDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
app.stderr.on('data', (d) => process.stderr.write(d));

try {
  const cdp = new CdpClient(Number(CDP_PORT));
  await cdp.findTarget((u) => u.startsWith('cadence-app://'), 40_000);
  const target = await cdp.findTarget((u) => u.startsWith('cadence-app://'), 10_000);
  const ui = new CdpClient(Number(CDP_PORT));
  await ui.attach(target);
  // trigger the apple session via a catalog call (best-effort)
  await ui.eval(`window.cadence.catalog.query('apple-musickit', {kind:'browse'}).catch(e=>String(e))`, 60_000).catch(()=>{});
  const amTarget = await cdp.findTarget((u) => u.includes('music.apple.com'), 30_000);
  console.log('provider target:', amTarget.url);
  const am = new CdpClient(Number(CDP_PORT));
  await am.attach(amTarget);
  const diag = await am.eval(`(async () => {
    const c = window.__cadenceCtl;
    if (!c) return { ctl: false };
    const out = { ctl: true, sf: c.storefront(), auth: c.isAuthorized() };
    try {
      const r = await c.amp('/v1/editorial/' + c.storefront() + '/groupings', {platform:'web', name:'browse', limit:'30'});
      out.groupingsKeys = r && r.data ? Object.keys(r.data) : null;
      out.raw = JSON.stringify(r).slice(0, 1500);
    } catch (e) { out.groupingsErr = String(e && e.message || e); }
    try {
      const r2 = await c.amp('/v1/catalog/' + c.storefront() + '/charts', {types:'songs,albums,playlists', limit:'5'});
      out.chartsKeys = r2 && r2.results ? Object.keys(r2.results) : null;
      const s = r2 && r2.results && r2.results.songs && r2.results.songs.data;
      out.chartSongs = s ? s.length : null;
    } catch (e) { out.chartsErr = String(e && e.message || e); }
    return out;
  })()`, 60_000);
  console.log(JSON.stringify(diag, null, 1));
  app.kill('SIGKILL');
  process.exit(0);
} catch (e) {
  console.error('FAIL', e);
  app.kill('SIGKILL');
  process.exit(1);
}

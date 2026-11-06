/**
 * Smoke test: real app + real music.apple.com, no sign-in needed.
 * Verifies: app boots under ECS, provider view installs, capabilities report,
 * catalog browse + search return live Apple Music data.
 *
 * Usage (from repo root, under xvfb):
 *   xvfb-run -a node test/e2e/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient, sleep, until } from './cdp.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');
const electronBin = join(desktopDir, 'node_modules', 'electron', 'dist', 'electron');
const CDP_PORT = process.env.CDP_PORT ?? '9333';
const profile = process.env.CADENCE_USER_DATA ?? `/tmp/cadence-e2e-${process.pid}`;

function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_DISABLE_SANDBOX = env.ELECTRON_DISABLE_SANDBOX ?? '1';
  env.CADENCE_E2E_CDP_PORT = CDP_PORT;
  env.CADENCE_USER_DATA = profile;
  return spawn(electronBin, ['--no-sandbox', desktopDir], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const app = launch();
let appLog = '';
app.stdout.on('data', (d) => (appLog += d));
app.stderr.on('data', (d) => (appLog += d));

function bail(msg) {
  console.error(`FAIL: ${msg}`);
  console.error('--- app log (tail) ---');
  console.error(appLog.slice(-3000));
  app.kill('SIGKILL');
  process.exit(1);
}

try {
  const cdp = new CdpClient(Number(CDP_PORT));
  const target = await cdp.findTarget((u) => u.startsWith('cadence-app://'), 40_000);
  await cdp.attach(target);
  console.log('attached to', target.url);

  await until(
    () => cdp.eval('typeof window.cadence !== "undefined"'),
    { label: 'window.cadence' },
  );
  console.log('PASS: window.cadence bridge live');

  // Capabilities — the apple route should exist and prepare (MusicKit install).
  const caps = await until(
    async () => {
      const list = await cdp.eval('window.cadence.getCapabilities()');
      const am = list?.find?.((c) => c.route === 'apple-musickit');
      return am && (am.state === 'ready' || am.state === 'unauthenticated') ? am : null;
    },
    { timeout: 60_000, label: 'apple-musickit capability' },
  );
  console.log(`PASS: apple-musickit capability state=${caps.state}`);

  // Catalog browse — works without a signed-in account.
  const browse = await cdp.eval(
    `window.cadence.catalog.query('apple-musickit', {kind:'browse'})`,
    30_000,
  );
  const sections = browse?.sections ?? [];
  const entryCount = sections.reduce((n, s) => n + s.entries.length, 0);
  if (!sections.length || !entryCount) bail(`browse returned ${sections.length} sections/${entryCount} entries`);
  console.log(`PASS: browse — ${sections.length} sections, ${entryCount} entries`);
  console.log('  sections:', sections.map((s) => `${s.title}(${s.entries.length})`).join(', '));

  // Catalog search — real data from amp-api.
  const search = await cdp.eval(
    `window.cadence.catalog.query('apple-musickit', {kind:'search', text:'daft punk', limit: 5})`,
    30_000,
  );
  const sSec = search?.sections ?? [];
  const songs = sSec.flatMap((s) => s.entries).filter((e) => e.kind === 'song');
  if (!songs.length) bail('search returned no songs');
  const first = songs[0].track;
  console.log(`PASS: search — ${songs.length} songs; first: "${first.title}" — ${first.artists[0]?.name} (${first.durationMs}ms)`);
  if (!first.source?.providerItemId || !first.durationMs) bail('search track missing play fields');

  // Radio sections.
  const radio = await cdp.eval(
    `window.cadence.catalog.query('apple-musickit', {kind:'radio'})`,
    30_000,
  );
  const stations = (radio?.sections ?? []).flatMap((s) => s.entries).filter((e) => e.kind === 'station');
  console.log(`PASS: radio — ${stations.length} stations`);

  // Platform model.
  const platform = await cdp.eval('window.cadence.platform.active()');
  await cdp.eval(`window.cadence.platform.setActive('apple')`);
  const after = await cdp.eval('window.cadence.platform.active()');
  if (after !== 'apple') bail(`platform.setActive didn't persist (got ${after})`);
  console.log(`PASS: platform ${platform} -> ${after}`);

  console.log('\nSMOKE: PASS');
  app.kill('SIGTERM');
  process.exit(0);
} catch (e) {
  bail(e instanceof Error ? e.message : String(e));
}

/**
 * Cadence Apple Music e2e — the real app vs the real service.
 *
 *   xvfb-run -a node test/e2e/apple-music.mjs
 *
 * Proves, with a signed-in session (no mocks):
 *   1. sign-in persists across launches (capability 'ready' without re-auth)
 *   2. search returns real catalog results
 *   3. the user's library loads (songs/albums/playlists)
 *   4. an album and a playlist open with full-length tracks
 *   5. a full track actually plays and produces real non-silent audio
 *      (PipeWire null-sink monitor recorded and measured)
 *   6. seek / pause / next / queue ops work
 *   7. restart restores queue+position and keeps the session
 *
 * Env: CADENCE_PROFILE=<dir with signed-in session, default ~/.config/cadence>
 */

import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient, sleep, until } from './cdp.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');
const electronBin = join(desktopDir, 'node_modules', 'electron', 'dist', 'electron');
const CDP_PORT = process.env.CDP_PORT ?? '9333';
const RUN = `/tmp/cadence-e2e-${process.pid}`;
const SINK = 'cadence-e2e';
const PROFILE_SRC = process.env.CADENCE_PROFILE ?? join(homedir(), '.config', 'cadence');
const PROFILE = join(RUN, 'profile');
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- PipeWire null sink -------------------------------------------------------

let sinkModule = null;
let prevDefaultSink = null;
function setupSink() {
  if (spawnSync('which', ['pactl']).status !== 0) {
    console.log('note: pactl missing — audio-level assertions will be skipped');
    return;
  }
  try {
    const out = execFileSync('pactl', [
      'load-module', 'module-null-sink',
      `sink_name=${SINK}`, `sink_properties=device.description=CadenceE2E`,
    ]).toString().trim();
    sinkModule = out;
    // Chromium ignores PULSE_SINK for its default output — route the whole
    // server at the null sink for the duration of the run, then restore.
    prevDefaultSink = execFileSync('pactl', ['get-default-sink']).toString().trim();
    execFileSync('pactl', ['set-default-sink', SINK]);
  } catch (e) {
    console.log('note: null sink failed:', String(e).slice(0, 200));
  }
}
function teardownSink() {
  if (prevDefaultSink) spawnSync('pactl', ['set-default-sink', prevDefaultSink]);
  if (sinkModule) spawnSync('pactl', ['unload-module', sinkModule]);
}

/** Move any app sink-inputs onto the null sink (defensive). */
function moveAppInputs() {
  try {
    const list = execFileSync('pactl', ['list', 'sink-inputs']).toString();
    for (const m of list.matchAll(/Sink Input #(\d+)/g)) {
      spawnSync('pactl', ['move-sink-input', m[1], SINK]);
    }
  } catch { /* noop */ }
}

/** Record the null-sink monitor for `ms`, return astats text. */
async function captureMonitor(ms, file) {
  const rec = spawn('parec', ['-d', `${SINK}.monitor`, '--file-format=wav', file]);
  await sleep(ms);
  rec.kill('SIGINT');
  await sleep(700);
  try {
    // ffmpeg reports astats on stderr even on success.
    const r = spawnSync('ffmpeg', [
      '-i', file, '-af', 'astats=measure_overall=Peak_level:measure_perchannel=none', '-f', 'null', '-',
    ]);
    return (r.stderr?.toString() ?? '') + (r.error ? String(r.error) : '');
  } catch (e) {
    return String(e);
  }
}

// --- app lifecycle -------------------------------------------------------------

let app = null;
let appLog = '';
function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WAYLAND_DISPLAY; // keep the window off Hyprland
  
  env.ELECTRON_DISABLE_SANDBOX = '1';
  env.CADENCE_E2E_CDP_PORT = CDP_PORT;
  env.CADENCE_USER_DATA = PROFILE;
  if (sinkModule) env.PULSE_SINK = SINK;
  app = spawn(electronBin, ['--no-sandbox', '--ozone-platform=x11', desktopDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', (d) => (appLog += d));
  app.stderr.on('data', (d) => (appLog += d));
}

async function stopApp() {
  if (!app) return;
  app.kill('SIGTERM');
  await until(() => app.exitCode !== null, { timeout: 10_000, interval: 300, label: 'app exit' }).catch(() => {
    app.kill('SIGKILL');
  });
  app = null;
}

const cdp = new CdpClient(Number(CDP_PORT));
let ui = null;

async function attach() {
  const target = await cdp.findTarget((u) => u.startsWith('cadence-app://'), 60_000);
  ui = new CdpClient(Number(CDP_PORT));
  await ui.attach(target);
  await until(() => ui.eval('typeof window.cadence !== "undefined"'), { label: 'window.cadence' });
}

const ev = (expr, t) => ui.eval(expr, t);

const waitFor = (fn, label, timeout = 30_000) => until(fn, { timeout, interval: 700, label });

// --- the test -------------------------------------------------------------------

try {
  if (!existsSync(PROFILE_SRC)) {
    throw new Error(`no profile at ${PROFILE_SRC} — sign in first`);
  }
  mkdirSync(RUN, { recursive: true });
  cpSync(PROFILE_SRC, PROFILE, { recursive: true });
  // Drop singleton locks from the copy so it can boot alongside the live app.
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile', 'Crashpad']) {
    rmSync(join(PROFILE, f), { force: true, recursive: true });
  }
  setupSink();
  launch();

  await attach();

  // --- 1. sign-in persisted --------------------------------------------------
  const cap = await waitFor(async () => {
    const list = await ev('window.cadence.getCapabilities()');
    const am = list?.find?.((c) => c.route === 'apple-musickit');
    return am && am.state !== 'unavailable' ? am : null;
  }, 'apple-musickit capability', 90_000);
  record('apple route reports capability', true, `state=${cap.state}`);
  record('sign-in persisted (route ready)', cap.state === 'ready', cap.stateDetail ?? '');

  // --- 2. search -------------------------------------------------------------
  const search = await ev(
    `window.cadence.catalog.query('apple-musickit', {kind:'search', text:'daft punk', limit:8})`, 40_000);
  const searchSongs = (search?.sections ?? []).flatMap((s) => s.entries).filter((e) => e.kind === 'song');
  record('catalog search returns songs', searchSongs.length > 0, `${searchSongs.length} songs`);
  const searchAlbum = (search?.sections ?? [])
    .flatMap((s) => s.entries)
    .find((e) => e.kind === 'album')?.album;
  const searchPlaylist = (search?.sections ?? [])
    .flatMap((s) => s.entries)
    .find((e) => e.kind === 'playlist')?.playlist;

  // --- 3. library ------------------------------------------------------------
  const libSongs = await ev(
    `window.cadence.catalog.query('apple-musickit', {kind:'library', collection:'songs', limit:25})`, 40_000)
    .catch((e) => ({ err: String(e) }));
  const libSongCount = (libSongs?.sections ?? []).flatMap((s) => s.entries).length;
  record('library songs query', Array.isArray(libSongs?.sections), `${libSongCount} entries`);
  const libAlbums = await ev(
    `window.cadence.catalog.query('apple-musickit', {kind:'library', collection:'albums', limit:10})`, 40_000)
    .catch((e) => ({ err: String(e) }));
  const libAlbumCount = (libAlbums?.sections ?? []).flatMap((s) => s.entries).length;
  const libPlaylists = await ev(
    `window.cadence.catalog.query('apple-musickit', {kind:'library', collection:'playlists', limit:10})`, 40_000)
    .catch((e) => ({ err: String(e) }));
  const libPlaylistCount = (libPlaylists?.sections ?? []).flatMap((s) => s.entries).length;
  record('library albums+playlists query', Array.isArray(libAlbums?.sections) && Array.isArray(libPlaylists?.sections),
    `${libAlbumCount} albums, ${libPlaylistCount} playlists`);

  // --- 4. album + playlist detail ---------------------------------------------
  const albumTarget =
    (libAlbums?.sections ?? []).flatMap((s) => s.entries).find((e) => e.kind === 'album')?.album ??
    searchAlbum;
  let albumTracks = [];
  if (albumTarget) {
    const req = albumTarget.isLibraryItem
      ? { kind: 'libraryDetail', collection: 'albums', id: albumTarget.id }
      : { kind: 'album', id: albumTarget.id };
    const page = await ev(
      `window.cadence.catalog.query('apple-musickit', ${JSON.stringify(req)})`, 40_000);
    albumTracks = (page?.sections ?? [])
      .flatMap((s) => s.entries)
      .filter((e) => e.kind === 'song')
      .map((e) => e.track);
  }
  record('album page opens with tracks', albumTracks.length > 0,
    albumTarget ? `"${albumTarget.title}" — ${albumTracks.length} tracks` : 'no album found');
  const fullTrack = albumTracks.find((t) => t.durationMs > 120_000);
  record('album has full-length tracks', !!fullTrack,
    fullTrack ? `"${fullTrack.title}" ${Math.round(fullTrack.durationMs / 1000)}s` : 'all tracks <120s?');

  const playlistTarget =
    (libPlaylists?.sections ?? []).flatMap((s) => s.entries).find((e) => e.kind === 'playlist')?.playlist ??
    searchPlaylist;
  let playlistTracks = [];
  if (playlistTarget) {
    const req = playlistTarget.isLibraryItem
      ? { kind: 'libraryDetail', collection: 'playlists', id: playlistTarget.id }
      : { kind: 'playlist', id: playlistTarget.id };
    const page = await ev(
      `window.cadence.catalog.query('apple-musickit', ${JSON.stringify(req)})`, 40_000)
      .catch((e) => ({ err: String(e) }));
    playlistTracks = (page?.sections ?? [])
      .flatMap((s) => s.entries)
      .filter((e) => e.kind === 'song')
      .map((e) => e.track);
  }
  record('playlist page opens', playlistTracks.length > 0,
    playlistTarget ? `"${playlistTarget.title}" — ${playlistTracks.length} tracks` : 'no playlist found');

  // --- 5. full-track playback + real audio -------------------------------------
  const playTracks = albumTracks.length >= 3 ? albumTracks.slice(0, 3) : albumTracks;
  if (playTracks.length) {
    await ev(
      `window.cadence.sendCommand({kind:'setQueue', items:${JSON.stringify(
        playTracks.map((track, i) => ({ queueId: `e2e-${i}`, track, origin: { kind: 'album', id: albumTarget?.id, name: albumTarget?.title } })),
      )}, startIndex:0, autoplay:true})`, 30_000);
    const snap = await waitFor(async () => {
      const s = await ev('window.cadence.getSnapshot()');
      return s?.status === 'playing' ? s : null;
    }, 'playback to reach playing', 60_000);
    record('track plays (snapshot playing)', true,
      `"${snap.current?.track?.title}" duration ${Math.round(snap.durationMs / 1000)}s`);
    record('plays a full track (not 30s preview)', snap.durationMs > 120_000,
      `${Math.round(snap.durationMs / 1000)}s`);

    // Let it run, then measure the null-sink monitor for real audio energy.
    await sleep(4000);
    moveAppInputs();
    const stats = await captureMonitor(8000, join(RUN, 'monitor.wav'));
    const peakMatch = stats.match(/Peak level dB:\s*(-?\d+(?:\.\d+)?)/);
    const peakDb = peakMatch ? parseFloat(peakMatch[1] ?? '-inf') : -Infinity;
    const pos = await ev('window.cadence.getSnapshot()');
    record('non-silent audio reaches the audio server', Number.isFinite(peakDb) && peakDb > -55,
      `monitor peak ${peakDb === -Infinity ? 'n/a' : peakDb.toFixed(1)}dBFS`);
    record('position advanced during playback', (pos?.positionMs ?? 0) > 8000,
      `${((pos?.positionMs ?? 0) / 1000).toFixed(1)}s`);

    // --- 6. transport ---------------------------------------------------------
    await ev(`window.cadence.sendCommand({kind:'seek', positionMs:60000})`);
    await sleep(1500);
    const seeked = await ev('window.cadence.getSnapshot()');
    record('seek works', Math.abs((seeked?.positionMs ?? 0) - 60000) < 4000,
      `position ${((seeked?.positionMs ?? 0) / 1000).toFixed(1)}s`);

    await ev(`window.cadence.sendCommand({kind:'pause'})`);
    const paused = await waitFor(async () => {
      const s = await ev('window.cadence.getSnapshot()');
      return s?.status === 'paused' ? s : null;
    }, 'paused state');
    record('pause works', true);

    await ev(`window.cadence.sendCommand({kind:'resume'})`);
    await waitFor(async () => {
      const s = await ev('window.cadence.getSnapshot()');
      return s?.status === 'playing' ? s : null;
    }, 'resume to playing');
    record('resume works', true);

    const beforeNext = (await ev('window.cadence.getSnapshot()'))?.current?.queueId;
    await ev(`window.cadence.sendCommand({kind:'next'})`, 30_000);
    const nextSnap = await waitFor(async () => {
      const s = await ev('window.cadence.getSnapshot()');
      return s?.status === 'playing' && s.current?.queueId !== beforeNext ? s : null;
    }, 'next track playing', 45_000);
    record('next works', true, `"${nextSnap.current?.track?.title}"`);

    // queue ops: insertNext + append + remove (coordinator re-stamps ids)
    const extra = searchSongs[0]?.track;
    if (extra) {
      await ev(`window.cadence.sendCommand({kind:'insertNext', items:[{queueId:'e2e-ins', track:${JSON.stringify(extra)}}]})`);
      await ev(`window.cadence.sendCommand({kind:'append', items:[{queueId:'e2e-app', track:${JSON.stringify(extra)}}]})`);
      await sleep(800);
      let q = await ev('window.cadence.getQueue()');
      const extraIds = (q?.items ?? []).filter((i) => i.track.id === extra.id).map((i) => i.queueId);
      record('queue insertNext+append', extraIds.length === 2 && (q?.items?.length ?? 0) === playTracks.length + 2,
        `${q?.items?.length} items`);
      await ev(`window.cadence.sendCommand({kind:'remove', queueIds:${JSON.stringify(extraIds)}})`).catch(() => {});
      q = await ev('window.cadence.getQueue()');
      record('queue remove', (q?.items?.length ?? 0) === playTracks.length, `${q?.items?.length} items`);
    }

    // --- lyrics ----------------------------------------------------------------
    const lyricsPage = await ev(
      `window.cadence.catalog.query('apple-musickit', {kind:'lyrics', songId:${JSON.stringify(String(nextSnap.current?.track?.source?.providerItemId ?? ''))}})`, 30_000)
      .catch(() => null);
    record('lyrics fetchable', lyricsPage !== null && (lyricsPage.lyrics === undefined || lyricsPage.lyrics.length > 0),
      lyricsPage?.lyrics ? `${lyricsPage.lyrics.split('\n').length} lines` : 'no lyrics for this track (ok)');
  } else {
    record('playback suite', false, 'no playable tracks found');
  }

  // --- 7. restart resume + session persistence ----------------------------------
  await ev(`window.cadence.sendCommand({kind:'pause'})`).catch(() => {});
  await sleep(1500); // let the persist debounce flush
  const preRestart = await ev('window.cadence.getSnapshot()');
  await stopApp();
  launch();
  await attach();
  const cap2 = await waitFor(async () => {
    const list = await ev('window.cadence.getCapabilities()');
    const am = list?.find?.((c) => c.route === 'apple-musickit');
    return am && am.state !== 'unavailable' ? am : null;
  }, 'capability after restart', 90_000);
  record('session survives app restart', cap2.state === 'ready', `state=${cap2.state}`);
  const restored = await ev('window.cadence.getSnapshot()');
  const queue = await ev('window.cadence.getQueue()');
  record('queue+position restored', (queue?.items?.length ?? 0) > 0 && restored?.status === 'paused',
    `${queue?.items?.length} items, ${Math.round((restored?.positionMs ?? 0) / 1000)}s, status=${restored?.status}`);

  // resume actually plays after restart — provider view can take a while to
  // warm up on a cold boot, so retry the command if the first stalls.
  const resumed = await waitFor(async () => {
    await ev(`window.cadence.sendCommand({kind:'resume'})`, 30_000).catch(() => {});
    const s = await ev('window.cadence.getSnapshot()');
    return s?.status === 'playing' ? s : null;
  }, 'resume after restart', 120_000);
  record('playback resumes after restart', true, `"${resumed.current?.track?.title}" @ ${Math.round(resumed.positionMs / 1000)}s`);

  await stopApp();
} catch (e) {
  record('harness', false, e instanceof Error ? e.message : String(e));
} finally {
  await stopApp().catch(() => {});
  teardownSink();
  writeFileSync(join(RUN, 'app.log'), appLog);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== E2E ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length} assertions ===`);
  console.log(`artifacts: ${RUN}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

/**
 * Injected controller for the Apple Music route.
 *
 * Preferred path — Sidra precedent: music.apple.com configures its own
 * MusicKit instance, so `MusicKit.getInstance()` returns a fully working SDK
 * (developer token included) with no paid key anywhere. Fallback: scrape the
 * developer token out of the page's own bootstrap JSON and configure our own
 * instance — still Apple's free web token, still no Apple Developer Program.
 *
 * Everything the main process does goes through `window.__cadenceCtl`.
 * Player state flows back via `emit(name, data)` -> the provider preload
 * bridge -> ProviderSession listeners.
 *
 * Audio settings arrive in `window.__cadenceAudioConfig`, set by the prelude
 * that `musickitInjectScript` puts in front of the controller.
 */

export interface MusicKitAudioConfig {
  /** Web Audio context rate; null keeps the browser default. */
  readonly contextRate: number | null;
  readonly eqBands: readonly { freqHz: number; gainDb: number }[];
}

/** The controller with the current audio settings in front of it. */
export function musickitInjectScript(config: MusicKitAudioConfig): string {
  return `window.__cadenceAudioConfig = ${JSON.stringify(config)};\n${MUSICKIT_CONTROLLER_JS}`;
}

export const MUSICKIT_CONTROLLER_JS = String.raw`
(() => {
  if (window.__cadenceCtl) return true;
  // Single-flight: concurrent injects (adapter prepare + did-finish-load)
  // share one install instead of racing the async MusicKit wait below.
  if (window.__cadenceCtlPromise) return window.__cadenceCtlPromise;
  const emit = (name, data) => {
    try { window.__cadenceBridge && window.__cadenceBridge.emit(name, data); } catch (e) {}
  };
  window.__cadenceCtlPromise = (async () => {
  try {

  async function waitForMK(tries = 24) {
    for (let i = 0; i < tries; i++) {
      if (window.MusicKit) return window.MusicKit;
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }
  const MK = await waitForMK();
  if (!MK) { emit('error', { message: 'MusicKit JS not present on this page' }); return false; }
  const requestedBitrate = Number(MK.PlaybackBitrate && MK.PlaybackBitrate.HIGH) || 256;

  // Wait for the site itself to configure an instance (it may do so lazily).
  let mk = null;
  for (let i = 0; i < 24 && !mk; i++) {
    try { mk = MK.getInstance(); } catch (e) { /* not configured yet */ }
    if (!mk) await new Promise(r => setTimeout(r, 500));
  }
  if (!mk) {
    // Fallback: reuse the developer token the page itself ships with.
    let devToken = null;
    try {
      for (const s of document.scripts) {
        if (s.id === 'serialized-server-data' || /application\/json/.test(s.type)) {
          const m = String(s.textContent || '').match(/"token"\s*:\s*"(eyJ[^"]+)"/);
          if (m) { devToken = m[1]; break; }
        }
      }
      if (!devToken) {
        const m = document.documentElement.innerHTML.match(/"token"\s*:\s*"(eyJ[^"]+)"/);
        if (m) devToken = m[1];
      }
    } catch (e) {}
    if (!devToken) { emit('needDeveloperToken', {}); return false; }
    try {
      mk = await MK.configure({ developerToken: devToken, bitrate: requestedBitrate, app: { name: 'Cadence', build: '0.1.0' } });
    } catch (e) {
      emit('error', { message: 'MusicKit configure failed: ' + (e && e.message || e) });
      return false;
    }
  }
  if (!mk) { emit('error', { message: 'MusicKit instance unavailable' }); return false; }

  function requestHighQuality() {
    try { mk.bitrate = requestedBitrate; }
    catch (e) { emit('error', { message: 'Apple Music high-quality playback could not be requested.' }); }
  }
  requestHighQuality();

  // Chromium clamps at full scale, and AAC decoding plus resampling lifts a
  // hot master's peaks just past it (+0.23 dB measured). 1 dB of margin
  // keeps those peaks intact at little cost in level.
  const outputHeadroom = Math.pow(10, -1 / 20);
  const initialVolume = Number(mk.volume);
  let outputVolume = Math.max(0, Math.min(1, Number.isFinite(initialVolume) ? initialVolume : 1)) * outputHeadroom;
  function applyOutputVolume() { if (mk.volume !== outputVolume) mk.volume = outputVolume; }
  applyOutputVolume();

  const STATES = (MK && MK.PlaybackStates) || {
    none: 0, loading: 1, playing: 2, paused: 3, stopped: 4,
    ended: 5, seeking: 6, waiting: 7, stalled: 8, completed: 9,
  };

  // --- Web Audio graph ----------------------------------------------------
  // Routing an element into Web Audio cannot be undone, so the graph is
  // built only once EQ or a context rate is asked for. Volume and the output
  // margin stay on mk.volume: Chromium applies the element's volume before
  // its audio enters the graph, so level is the same on either path.
  //   element -> source -> input -> dry ------------------> trim -> destination
  //                              \-> peaking x N -> wet -/
  const audioConfig = window.__cadenceAudioConfig || {};
  const configRate = Number(audioConfig.contextRate);
  const requestedRate = Number.isInteger(configRate) && configRate >= 8000 && configRate <= 384000
    ? configRate : null;
  const AudioCtor = window.AudioContext || window.webkitAudioContext || null;
  const EQ_RAMP_S = 0.03;
  const graph = {
    state: AudioCtor ? 'direct' : 'unsupported',
    error: null,
    ctx: null, input: null, dry: null, trim: null,
    wet: null, filters: [], filterKey: '',
    element: null,
    sources: new WeakMap(),
    rejected: new WeakSet(),
    resuming: false,
    suspendedTicks: 0,
    reported: false,
  };

  function normalizeBands(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 32)
      .filter(b => b && Number.isFinite(b.freqHz) && Number.isFinite(b.gainDb))
      .map(b => ({ freqHz: b.freqHz, gainDb: b.gainDb }));
  }
  let eqBands = normalizeBands(audioConfig.eqBands);
  // The engine skips bands this close to 0 dB; so does the page.
  const audibleGain = g => Math.abs(g) > 0.01 ? g : 0;
  const eqActive = () => eqBands.some(b => audibleGain(b.gainDb) !== 0);
  const wantGraph = () => requestedRate !== null || eqActive();

  function reportGraphError(message) {
    graph.error = message;
    if (graph.reported) return;
    graph.reported = true;
    emit('error', { message });
  }

  // RBJ peaking magnitude in dB, Q = 1: the engine's and Web Audio's formula.
  function peakingDb(freq, gainDb, at, rate) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * freq / rate;
    const alpha = Math.sin(w0) / 2;
    const c0 = Math.cos(w0);
    const b0 = 1 + alpha * A, b1 = -2 * c0, b2 = 1 - alpha * A;
    const a0 = 1 + alpha / A, a1 = -2 * c0, a2 = 1 - alpha / A;
    const w = 2 * Math.PI * at / rate;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = b1 * s1 + b2 * s2;
    const dr = a0 + a1 * c1 + a2 * c2, di = a1 * s1 + a2 * s2;
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  // Highest gain of the whole band stack, so boosts can be paid for with an
  // equal cut and never push already-hot peaks into Chromium's clamp.
  function eqPeakDb(bands, rate) {
    const live = bands.filter(b => b.gainDb !== 0);
    if (!live.length) return 0;
    const top = Math.min(20000, rate / 2 - 1);
    const probes = live.map(b => b.freqHz);
    for (let i = 0; i <= 240; i++) probes.push(20 * Math.pow(top / 20, i / 240));
    let peak = 0;
    for (const at of probes) {
      let db = 0;
      for (const b of live) db += peakingDb(b.freqHz, b.gainDb, at, rate);
      if (db > peak) peak = db;
    }
    return peak;
  }

  function setParam(param, value, now, ramp) {
    try {
      if (!ramp) { param.cancelScheduledValues(0); param.value = value; return; }
      // Hold wherever a running ramp has got to, then glide; a jump clicks.
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
      else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
      param.linearRampToValueAtTime(value, now + EQ_RAMP_S);
    } catch (e) { param.value = value; }
  }

  function applyEq(ramp) {
    const ctx = graph.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const rate = ctx.sampleRate;
    const active = eqActive();
    const bands = eqBands.map(b => ({
      freqHz: Math.min(rate / 2 - 1, Math.max(10, b.freqHz)),
      gainDb: audibleGain(b.gainDb),
    }));
    const key = active ? bands.map(b => b.freqHz).join(',') : '';
    const trim = Math.pow(10, -eqPeakDb(active ? bands : [], rate) / 20);
    if (key === graph.filterKey) {
      // Same bands: glide the gains, no rewiring.
      graph.filters.forEach((f, i) => setParam(f.gain, bands[i].gainDb, now, ramp));
      setParam(graph.trim.gain, trim, now, ramp);
      return;
    }
    let next = null;
    if (active) {
      // Build the new chain off to the side; the live path is untouched
      // until it is complete.
      const filters = [];
      let wet = null;
      try {
        for (const b of bands) {
          const f = ctx.createBiquadFilter();
          f.type = 'peaking';
          f.frequency.value = b.freqHz;
          f.Q.value = 1;
          f.gain.value = b.gainDb;
          if (filters.length) filters[filters.length - 1].connect(f);
          filters.push(f);
        }
        wet = ctx.createGain();
        wet.gain.value = 0;
        filters[filters.length - 1].connect(wet);
        wet.connect(graph.trim);
        graph.input.connect(filters[0]);
      } catch (e) {
        // input -> filters is the last connection made, so the live path
        // never saw this chain.
        for (const f of filters) { try { f.disconnect(); } catch (e2) {} }
        if (wet) { try { wet.disconnect(); } catch (e2) {} }
        reportGraphError('Apple Music EQ could not be applied: ' + (e && e.message || e));
        return;
      }
      next = { filters, wet };
    }
    const old = graph.wet ? { filters: graph.filters, wet: graph.wet } : null;
    // Crossfade from the current path to the new one.
    setParam(graph.dry.gain, active ? 0 : 1, now, ramp);
    if (next) setParam(next.wet.gain, 1, now, ramp);
    if (old) setParam(old.wet.gain, 0, now, ramp);
    setParam(graph.trim.gain, trim, now, ramp);
    graph.filters = next ? next.filters : [];
    graph.wet = next ? next.wet : null;
    graph.filterKey = key;
    if (old) {
      const drop = () => {
        try { graph.input.disconnect(old.filters[0]); } catch (e) {}
        try { old.wet.disconnect(); } catch (e) {}
      };
      if (ramp) setTimeout(drop, EQ_RAMP_S * 1000 + 50); else drop();
    }
  }

  function ensureContext() {
    if (graph.ctx) return graph.ctx;
    // Default rate unless asked: a sampleRate argument makes Chromium
    // resample everything the page plays to that rate.
    const ctx = requestedRate !== null ? new AudioCtor({ sampleRate: requestedRate }) : new AudioCtor();
    try {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const trim = ctx.createGain();
      // The whole path reaches the destination before any element is routed in.
      input.connect(dry);
      dry.connect(trim);
      trim.connect(ctx.destination);
      Object.assign(graph, { ctx, input, dry, trim });
    } catch (e) {
      try { ctx.close(); } catch (e2) {}
      throw e;
    }
    try {
      ctx.addEventListener('statechange', () => {
        if (ctx.state !== 'running' && mk.playbackState === STATES.playing) resumeContext();
        post(false);
      });
    } catch (e) {}
    applyEq(false);
    return ctx;
  }

  function resumeContext() {
    const ctx = graph.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed' || graph.resuming) return;
    graph.resuming = true;
    Promise.resolve()
      .then(() => ctx.resume())
      .catch(() => {})
      .then(() => {
        graph.resuming = false;
        if (ctx.state === 'running') { ensureGraph(); post(false); }
      });
  }

  function findElement() {
    try {
      const byId = document.getElementById('apple-music-player');
      if (byId) return byId;
      for (const el of document.querySelectorAll('audio')) {
        if (/^blob:/.test(el.currentSrc || el.src || '')) return el;
      }
    } catch (e) {}
    return null;
  }

  function attach(el) {
    let source = graph.sources.get(el);
    if (!source) {
      try {
        source = graph.ctx.createMediaElementSource(el);
      } catch (e) {
        // Already routed elsewhere: the element keeps the path it has.
        graph.rejected.add(el);
        reportGraphError('Apple Music EQ could not reach the player: ' + (e && e.message || e));
        return;
      }
      graph.sources.set(el, source);
      try { source.connect(graph.input); }
      catch (e) {
        // The element now only sounds through Web Audio; never leave it unconnected.
        try { source.connect(graph.ctx.destination); } catch (e2) {}
        reportGraphError('Apple Music EQ could not be connected: ' + (e && e.message || e));
        return;
      }
    }
    graph.element = el;
    graph.state = 'attached';
  }

  function ensureGraph() {
    // Once built, the graph keeps following MusicKit's element even with EQ flat.
    if (graph.state === 'failed' || (!graph.ctx && !wantGraph())) return;
    if (graph.state === 'unsupported') {
      reportGraphError('Apple Music EQ is unavailable: this page has no Web Audio.');
      return;
    }
    let ctx;
    try { ctx = ensureContext(); }
    catch (e) {
      graph.state = 'failed';
      reportGraphError('Apple Music EQ is unavailable; playing without it. ' + (e && e.message || e));
      return;
    }
    if (ctx.state !== 'running') resumeContext();
    const el = findElement();
    // Only MediaSource streams (blob: URLs) are same-origin; a cross-origin
    // file routed into Web Audio plays as silence. A stopped context would
    // silence the element too, so it stays direct until the context runs.
    if (el && el !== graph.element && !graph.rejected.has(el) &&
        ctx.state === 'running' && /^blob:/.test(el.currentSrc || el.src || '')) {
      attach(el);
    }
    if (!graph.element) graph.state = 'waiting';
  }

  // Play must not start into a stopped context.
  async function readyGraph() {
    ensureGraph();
    const ctx = graph.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try { await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 1500))]); } catch (e) {}
    ensureGraph();
  }

  function watchGraph() {
    ensureGraph();
    const ctx = graph.ctx;
    if (!ctx || graph.state !== 'attached' || ctx.state === 'running' ||
        mk.playbackState !== STATES.playing) { graph.suspendedTicks = 0; return; }
    resumeContext();
    if (++graph.suspendedTicks === 4) {
      emit('error', { message: 'Apple Music output is stalled: its Web Audio context is ' + ctx.state + '.' });
    }
  }

  function apiImpl() {
    const a = mk.api;
    if (!a) return null;
    if (typeof a.music === 'function') return { music: a.music.bind(a), raw: a };
    if (a.v3 && typeof a.v3.music === 'function') return { music: a.v3.music.bind(a.v3), raw: a };
    return { music: null, raw: a };
  }

  async function amp(path, params, method) {
    const a = apiImpl();
    if (!a) throw new Error('mk.api unavailable');
    const m = String(method || 'GET').toLowerCase();
    if (m === 'get' && a.music) {
      const r = await a.music(path, params || {});
      // mk.api.music resolves {url,status,text}; parse for callers.
      if (r && typeof r.text === 'string') { try { return JSON.parse(r.text); } catch (e) { return r; } }
      if (r && r.data !== undefined) return r;
      return r;
    }
    const verb = a.raw && typeof a.raw[m] === 'function' ? a.raw[m].bind(a.raw) : null;
    if (!verb) throw new Error('mk.api has no ' + m + ' method');
    return verb(path, params || {});
  }

  let accountStorefront = null;
  let accountToken = null;
  async function storefront() {
    if (!mk.isAuthorized) return mk.storefrontId || 'us';
    // The site's /us/browse bootstrap can be signed into an Indian account.
    // Preview requests tolerate this; full playback rejects CONTENT_EQUIVALENT.
    if (!accountStorefront || accountToken !== mk.musicUserToken) {
      const response = await amp('/v1/me/storefront');
      const id = response && response.data && response.data[0] && response.data[0].id;
      if (typeof id !== 'string' || !/^[a-z]{2}$/.test(id)) {
        throw new Error('Could not determine your Apple Music account region. Try again.');
      }
      accountStorefront = id;
      accountToken = mk.musicUserToken;
    }
    mk.storefrontId = accountStorefront;
    return accountStorefront;
  }

  async function requireFullPlayback() {
    if (!mk.isAuthorized) throw new Error('Sign in to Apple Music to play full songs.');
    const subscribed = typeof mk.hasMusicSubscription === 'function'
      ? await mk.hasMusicSubscription() : await mk.hasMusicSubscription;
    if (subscribed === false) throw new Error('An active Apple Music subscription is required to play full songs.');
    await storefront();
    // music.apple.com can leave its shared SDK in PREVIEW_ONLY even for a
    // signed-in subscriber. This public setter selects protected full audio.
    mk.previewOnly = false;
    requestHighQuality();
  }

  // --- queue bookkeeping -------------------------------------------------
  // We mirror the coordinator's intent minimally: the mk queue always holds
  // [current, ...mirrored successors]. 'appended' tracks ids we pushed via
  // playLater so refresh calls can dedupe/replace instead of piling up.
  let appended = [];
  let changingQueue = false;

  function queueInfo() {
    const q = mk.queue;
    const items = (q && q.items) || [];
    const pos = q && typeof q.position === 'number' ? q.position : -1;
    const next = pos >= 0 && items[pos + 1] ? items[pos + 1] : null;
    return {
      position: pos,
      length: items.length,
      nextItemId: next ? String(next.id) : null,
    };
  }

  function itemSpecToQueueArg(spec) {
    // spec: {type:'song'|'library-song'|'station'|'album'|'playlist', id}
    if (spec.type === 'station') return { station: spec.id };
    if (spec.type === 'album') return { album: spec.id };
    if (spec.type === 'playlist') return { playlist: spec.id };
    // Library ids resolve through the plain {song:id} form — the {items:[…]}
    // form returns mk-007 NOT_FOUND for library-songs on current MusicKit.
    return { song: spec.id };
  }

  async function setQueueAndPlay(spec, positionMs) {
    changingQueue = true;
    try {
      // Stop the old stream immediately, before any asynchronous account or
      // queue work. Loading the replacement must never replay its old tail.
      await mk.pause();
      await requireFullPlayback();
      const arg = itemSpecToQueueArg(spec);
      appended = [];
      if (spec.type === 'station') {
        try { await mk.setQueue(arg); }
        catch (e) {
          if (typeof mk.setStationQueue === 'function') await mk.setStationQueue(spec.id);
          else throw e;
        }
      } else {
        try {
          await mk.setQueue(arg);
        } catch (e) {
          if (spec.type !== 'song') throw e;
          // Library-minted ids occasionally need the items form.
          await mk.setQueue({ items: [{ id: spec.id, type: 'song' }] });
        }
      }
      if (typeof mk.autoplayEnabled !== 'undefined') mk.autoplayEnabled = false;
      applyOutputVolume();
      await readyGraph();
      await mk.play();
      applyOutputVolume();
      ensureGraph();
      // Seek after loading the stream, including zero. Seeking before play
      // can target the previous item; skipping zero retains its old position.
      const targetSeconds = Math.max(0, positionMs || 0) / 1000;
      if (spec.type !== 'station' && (targetSeconds > 0 || mk.currentPlaybackTime > 0)) {
        await mk.seekToTime(targetSeconds);
      }
    } finally {
      changingQueue = false;
    }
    post(true);
    return true;
  }

  async function appendSpec(spec) {
    const arg = itemSpecToQueueArg(spec);
    if (typeof mk.playLater === 'function') {
      await mk.playLater(arg);
    } else if (mk.queue && typeof mk.queue.append === 'function') {
      mk.queue.append(arg);
    } else {
      throw new Error('no queue-append primitive on this MusicKit build');
    }
    appended.push({ id: spec.id, type: spec.type });
  }

  function playParamsKind(item) {
    const pp = item && item.playParams;
    return pp ? String(pp.kind || '') : '';
  }

  let last = '';
  let lastNowPlayingId = null;
  let lastNowPlayingPos = -1;
  let previewError = '';
  function post(force) {
    const item = mk.nowPlayingItem;
    const st = mk.playbackState;
    const qi = queueInfo();
    const streamDuration = Math.round((mk.currentPlaybackDuration || 0) * 1000);
    const catalogDuration = item && item.attributes && Number(item.attributes.durationInMillis) || 0;
    const dur = catalogDuration || streamDuration;
    const posMs = Math.round((mk.currentPlaybackTime || 0) * 1000);
    const clipped = !changingQueue && catalogDuration > 0 && streamDuration > 0 &&
      streamDuration + 2000 < catalogDuration &&
      (st === STATES.playing || st === STATES.ended || st === STATES.completed);
    if (clipped) {
      const key = String(item.id) + ':' + streamDuration;
      if (previewError !== key) {
        previewError = key;
        mk.pause();
        emit('error', { message: 'Apple Music returned a preview instead of the full song. Playback stopped; try signing in again.' });
      }
    } else if (!changingQueue && st === STATES.playing) previewError = '';
    // Only MusicKit's terminal states mean the track ended — a transient
    // 'stopped' (mid-setQueue, unauthorize, stall) must not advance intent.
    // Lingering 'ended' states post-transition are stale unless the position
    // is actually at the tail — a real end has already played the track out.
    // At the end of a provider queue MusicKit can clear the item and reset
    // its position and duration before reporting completion.
    const naturalEnd =
      !changingQueue && !clipped && (st === STATES.ended || st === STATES.completed) &&
      (!item ? true : dur === 0 ? false : posMs >= dur - 1500);
    const s = {
      state: clipped ? 'paused' : changingQueue ? 'buffering' : st === STATES.playing ? 'playing'
        : st === STATES.paused ? 'paused'
        : st === STATES.loading || st === STATES.waiting
          || st === STATES.stalled || st === STATES.seeking ? 'buffering'
        : st === STATES.stopped ? 'stopped'
        : st === STATES.ended || st === STATES.completed ? 'ended' : 'idle',
      positionMs: posMs,
      durationMs: dur,
      isAuthorized: !!mk.isAuthorized,
      // Selection diagnostics only; these do not measure delivered media.
      requestedBitrateKbps: requestedBitrate,
      sdkBitrateKbps: Number(mk.bitrate) || null,
      audioGraph: graph.state,
      audioGraphError: graph.error,
      contextSampleRateHz: graph.ctx ? graph.ctx.sampleRate : null,
      contextState: graph.ctx ? graph.ctx.state : null,
      eqFilters: graph.filters.length,
      nowPlayingId: item ? String(item.id) : null,
      nowPlayingKind: playParamsKind(item),
      queuePos: qi.position,
      queueLen: qi.length,
      nextItemId: qi.nextItemId,
      ended: naturalEnd,
      title: item ? item.attributes && item.attributes.name : null,
      artist: item ? item.attributes && item.attributes.artistName : null,
      album: item ? item.attributes && item.attributes.albumName : null,
    };
    const j = JSON.stringify(s);
    if (force || j !== last) { last = j; emit('playerState', s); }
    // Emit on item-id change OR queue-position change — consecutive copies
    // of the same song share an id but advance the position.
    if (item && (String(item.id) !== lastNowPlayingId || qi.position !== lastNowPlayingPos)) {
      lastNowPlayingId = item ? String(item.id) : lastNowPlayingId;
      lastNowPlayingPos = qi.position;
      // A mirrored item that MusicKit promoted is no longer a successor —
      // consume it so clearPlayLater can't remove the now-current item.
      appended = appended.filter(a => String(a.id) !== String(item.id));
      emit('nowPlaying', { id: s.nowPlayingId, kind: s.nowPlayingKind, queuePos: s.queuePos });
    }
    if (!item) lastNowPlayingId = null;
  }

  mk.addEventListener('playbackStateDidChange', () => { applyOutputVolume(); watchGraph(); post(true); });
  mk.addEventListener('playbackTimeDidChange', () => post(false));
  mk.addEventListener('nowPlayingItemDidChange', () => post(true));
  if (MK.Events && MK.Events.authorizationStatusDidChange) {
    try { mk.addEventListener('authorizationStatusDidChange', () => post(true)); } catch (e) {}
  }

  window.__cadenceCtl = {
    mk,
    // --- introspection ---
    storefront,
    isAuthorized() { try { return !!mk.isAuthorized; } catch (e) { return false; } },
    state() { post(true); return true; },
    // --- data ---
    amp,
    // --- playback ---
    play: setQueueAndPlay,
    // Skip inside the mirrored queue (manual next landing on a prefetch).
    async skipTo(spec) {
      await requireFullPlayback();
      const qi = queueInfo();
      if (qi.nextItemId === String(spec.id)) { await mk.skipToNextItem(); }
      else { await setQueueAndPlay(spec, 0); }
      applyOutputVolume();
      ensureGraph();
      post(true);
      return true;
    },
    pause() { mk.pause(); post(true); return true; },
    async resume() {
      await requireFullPlayback();
      applyOutputVolume();
      await readyGraph();
      await mk.play();
      applyOutputVolume();
      ensureGraph();
      post(true);
      return true;
    },
    seek(ms) { return mk.seekToTime(ms / 1000).then(() => (post(true), true)); },
    next() { return mk.skipToNextItem().then(() => (post(true), true)); },
    previous() { return mk.skipToPreviousItem().then(() => (post(true), true)); },
    setVolume(x) { outputVolume = Math.max(0, Math.min(1, x)) * outputHeadroom; applyOutputVolume(); return true; },
    // Live EQ: gains glide, so playback never restarts.
    setEq(bands) {
      eqBands = normalizeBands(bands);
      ensureGraph();
      if (graph.state !== 'failed') applyEq(true);
      post(true);
      return !graph.error && graph.state !== 'failed' && graph.state !== 'unsupported';
    },
    // --- queue mirror ---
    async playLater(spec) {
      // Dedupe: a successor refresh for the same id is a no-op.
      if (appended.some(a => a.id === spec.id)) return true;
      await appendSpec(spec);
      post(true);
      return true;
    },
    async clearPlayLater() {
      // Remove the mirrored successors from MusicKit's own queue too — a
      // stale playLater item would otherwise play at the boundary.
      const ids = new Set(appended.map(a => String(a.id)));
      appended = [];
      const q = mk.queue;
      const items = (q && q.items) || [];
      const pos = q && typeof q.position === 'number' ? q.position : -1;
      for (let i = items.length - 1; i >= 0; i--) {
        // Duplicate songs share ids — only ever remove mirrored successors,
        // i.e. items strictly after the playhead.
        if (i <= pos || !ids.has(String(items[i].id))) continue;
        try {
          if (typeof mk.removeItem === 'function') await mk.removeItem(i);
          else items.splice(i, 1);
        } catch (e) {}
      }
      try { if (typeof mk.updateQueue === 'function') mk.updateQueue(); } catch (e) {}
      post(true);
      return true;
    },
    // --- auth ---
    async authorize() {
      if (typeof mk.authorize === 'function') return mk.authorize();
      return false;
    },
    async unauthorize() {
      if (typeof mk.unauthorize === 'function') return mk.unauthorize();
      return false;
    },
    // Read-back probe — the adapter uses it to confirm an unrecognized
    // nowPlaying item is still current before acting on it.
    npId() {
      const item = mk.nowPlayingItem;
      return { id: item ? String(item.id) : null, pos: queueInfo().position };
    },
    // Best-effort click on the site's own sign-in affordance.
    clickSignIn() {
      const el = document.querySelector(
        '[data-testid="sign-in-button"], [aria-label*="Sign In" i], button.sign-in, #sign-in'
      );
      if (el) { el.click(); return true; }
      return false;
    },
  };
  ensureGraph();
  post(true);
  // Always post on the tick — a frozen boundary state must keep reaching the
  // adapter (position-at-tail detection depends on periodic samples, and a
  // deduped silence looks identical to healthy idle playback).
  setInterval(() => { applyOutputVolume(); watchGraph(); post(true); }, 750);
  return true;
  } finally {
    // A failed install must not poison later retries (navigations re-inject).
    if (!window.__cadenceCtl) window.__cadenceCtlPromise = null;
  }
  })();
  return window.__cadenceCtlPromise;
})()`;

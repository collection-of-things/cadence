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
 */

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
      mk = await MK.configure({ developerToken: devToken, app: { name: 'Cadence', build: '0.1.0' } });
    } catch (e) {
      emit('error', { message: 'MusicKit configure failed: ' + (e && e.message || e) });
      return false;
    }
  }
  if (!mk) { emit('error', { message: 'MusicKit instance unavailable' }); return false; }

  const STATES = (MK && MK.PlaybackStates) || {
    none: 0, loading: 1, playing: 2, paused: 3, stopped: 4,
    ended: 5, seeking: 6, waiting: 7, stalled: 8, completed: 9,
  };

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

  // --- queue bookkeeping -------------------------------------------------
  // We mirror the coordinator's intent minimally: the mk queue always holds
  // [current, ...mirrored successors]. 'appended' tracks ids we pushed via
  // playLater so refresh calls can dedupe/replace instead of piling up.
  let appended = [];

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
    if (positionMs && positionMs > 0) {
      try { await mk.seekToTime(positionMs / 1000); } catch (e) {}
    }
    if (typeof mk.autoplayEnabled !== 'undefined') mk.autoplayEnabled = false;
    await mk.play();
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
  function post(force) {
    const item = mk.nowPlayingItem;
    const st = mk.playbackState;
    const qi = queueInfo();
    const dur = Math.round((item && item.playDuration) || (mk.currentPlaybackDuration * 1000) || 0);
    const posMs = Math.round((mk.currentPlaybackTime || 0) * 1000);
    // Only MusicKit's terminal states mean the track ended — a transient
    // 'stopped' (mid-setQueue, unauthorize, stall) must not advance intent.
    const naturalEnd = st === STATES.ended || st === STATES.completed;
    const s = {
      state: st === STATES.playing ? 'playing'
        : st === STATES.paused ? 'paused'
        : st === STATES.loading || st === STATES.waiting
          || st === STATES.stalled || st === STATES.seeking ? 'buffering'
        : st === STATES.stopped ? 'stopped'
        : st === STATES.ended || st === STATES.completed ? 'ended' : 'idle',
      positionMs: posMs,
      durationMs: dur,
      isAuthorized: !!mk.isAuthorized,
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
    if (item && String(item.id) !== lastNowPlayingId) {
      lastNowPlayingId = item ? String(item.id) : lastNowPlayingId;
      // A mirrored item that MusicKit promoted is no longer a successor —
      // consume it so clearPlayLater can't remove the now-current item.
      appended = appended.filter(a => String(a.id) !== String(item.id));
      emit('nowPlaying', { id: s.nowPlayingId, kind: s.nowPlayingKind, queuePos: s.queuePos });
    }
    if (!item) lastNowPlayingId = null;
  }

  mk.addEventListener('playbackStateDidChange', () => post(true));
  mk.addEventListener('playbackTimeDidChange', () => post(false));
  mk.addEventListener('nowPlayingItemDidChange', () => post(true));
  if (MK.Events && MK.Events.authorizationStatusDidChange) {
    try { mk.addEventListener('authorizationStatusDidChange', () => post(true)); } catch (e) {}
  }

  window.__cadenceCtl = {
    mk,
    // --- introspection ---
    storefront() { try { return mk.storefrontId; } catch (e) { return 'us'; } },
    isAuthorized() { try { return !!mk.isAuthorized; } catch (e) { return false; } },
    state() { post(true); return true; },
    // --- data ---
    amp,
    // --- playback ---
    play: setQueueAndPlay,
    // Skip inside the mirrored queue (manual next landing on a prefetch).
    async skipTo(spec) {
      const qi = queueInfo();
      if (qi.nextItemId === String(spec.id)) { await mk.skipToNextItem(); }
      else { await setQueueAndPlay(spec, 0); }
      post(true);
      return true;
    },
    pause() { mk.pause(); post(true); return true; },
    resume() { return mk.play().then(() => (post(true), true)); },
    seek(ms) { return mk.seekToTime(ms / 1000).then(() => (post(true), true)); },
    next() { return mk.skipToNextItem().then(() => (post(true), true)); },
    previous() { return mk.skipToPreviousItem().then(() => (post(true), true)); },
    setVolume(x) { try { mk.volume = Math.max(0, Math.min(1, x)); } catch (e) {} return true; },
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
        // Duplicate songs share ids — never remove the item at the playhead.
        if (i === pos || !ids.has(String(items[i].id))) continue;
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
    // Best-effort click on the site's own sign-in affordance.
    clickSignIn() {
      const el = document.querySelector(
        '[data-testid="sign-in-button"], [aria-label*="Sign In" i], button.sign-in, #sign-in'
      );
      if (el) { el.click(); return true; }
      return false;
    },
  };
  post(true);
  setInterval(() => post(false), 750);
  return true;
  } finally {
    // A failed install must not poison later retries (navigations re-inject).
    if (!window.__cadenceCtl) window.__cadenceCtlPromise = null;
  }
  })();
  return window.__cadenceCtlPromise;
})()`;

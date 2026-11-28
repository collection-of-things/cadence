/**
 * Injected controller for music.youtube.com. Installed via executeJavaScript
 * in the page world (and re-injected after every page load). Exposes
 * window.__cadenceCtl for commands and posts player state through
 * window.__cadenceBridge.emit (installed by the provider preload).
 *
 * Strategy follows the Kaset/Pear precedent: drive the real <video> element
 * and the site's own SPA router, read state back from the player. We navigate
 * rather than manipulate the provider queue; on any queue-sync doubt we prefer
 * the correct song and accept a gap — per the v3 doc.
 *
 * Cadence owns the queue: when the requested track finishes, the site's own
 * autoplay is held paused until the adapter asks for the next track.
 */

export const YTM_CONTROLLER_JS = String.raw`
(() => {
  if (window.__cadenceCtl) return true;
  const emit = (name, data) => {
    try { window.__cadenceBridge && window.__cadenceBridge.emit(name, data); } catch (e) {}
  };
  const video = () => document.querySelector('video');
  const player = () => document.querySelector('#movie_player');
  const playerBar = () => document.querySelector('ytmusic-player-bar');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function waitFor(pred, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const v = pred(); if (v) return v; } catch (e) {}
      await sleep(50);
    }
    return null;
  }

  const bootId = Math.random().toString(36).slice(2);
  let expected = null;     // videoId Cadence asked for
  let generationId = null;
  let switching = false;
  let holdAfterEnd = false; // keep the site's autoplay silent until the next play()
  let endedEmitted = false;
  const playingVideos = new WeakMap();
  let lastGood = { positionMs: 0, durationMs: 0 };
  let lastKey = '';

  function currentId() {
    const p = player();
    const id = p && typeof p.getVideoData === 'function' ? p.getVideoData()?.video_id : null;
    if (id) return id;
    try { return new URL(location.href).searchParams.get('v'); } catch (e) { return null; }
  }
  const isAd = () => !!player()?.classList.contains('ad-showing');

  function readState() {
    const v = video();
    const base = { bootId, generationId, expectedVideoId: expected, url: location.href };
    if (!v) return {
      ...base, ...lastGood, state: endedEmitted ? 'ended' : 'idle',
      volume: 1, title: '', byline: '', videoId: null, ad: false,
    };
    const ad = isAd();
    const bar = playerBar();
    let state = 'paused';
    // Ads run in the same <video>: report them as buffering with the track's
    // position held, never as the track itself.
    if (ad) state = v.paused ? 'paused' : 'buffering';
    else if (endedEmitted) state = 'ended';
    else if (v.readyState < 3 && !v.paused) state = 'buffering';
    else if (!v.paused) state = 'playing';
    if (!ad && !endedEmitted) {
      lastGood = {
        positionMs: Math.round(v.currentTime * 1000),
        durationMs: Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 0,
      };
    }
    return {
      ...base,
      state,
      ad,
      videoId: ad ? expected : currentId(),
      positionMs: lastGood.positionMs,
      durationMs: lastGood.durationMs,
      volume: v.volume,
      title: bar ? (bar.querySelector('.title')?.textContent || '').trim() : '',
      byline: bar ? (bar.querySelector('.byline')?.textContent || '').trim() : '',
    };
  }

  function markEnded() {
    if (switching || endedEmitted || !expected || isAd()) return;
    endedEmitted = true;
    holdAfterEnd = true;
    const v = video();
    if (v && !v.paused) v.pause();
    postState(true);
  }

  function trackPlayingVideo(v) {
    // A detached video no longer sends events through document capture.
    // It can still report completion while metadata points at the next pick.
    if (!playingVideos.has(v)) {
      v.addEventListener('ended', () => {
        if (v.ended && playingVideos.get(v) === generationId) markEnded();
      });
    }
    playingVideos.set(v, generationId);
  }

  function enforceHold() {
    if (!holdAfterEnd) return;
    const v = video();
    if (v && !v.paused) v.pause();
  }

  function postState(force) {
    if (switching) return;
    if (expected && !endedEmitted && !isAd()) {
      const id = currentId();
      const v = video();
      // Site redirects can change the ID without ending playback. Only
      // advance on a terminal event or a clock that already reached its end.
      const completedBeforeChange = id && id !== expected && lastGood.durationMs > 0 &&
        lastGood.positionMs >= lastGood.durationMs;
      if ((v?.ended && playingVideos.get(v) === generationId) || completedBeforeChange) {
        markEnded();
        return;
      } else if (id) {
        expected = id;
      }
      if (v && !v.paused) trackPlayingVideo(v);
    }
    enforceHold();
    const s = readState();
    const key = s.state + '|' + s.videoId + '|' + s.ad + '|' + s.positionMs + '|' + s.durationMs + '|' + s.title;
    if (force || key !== lastKey) {
      lastKey = key;
      emit('playerState', s);
    }
  }

  function seekTo(ms) {
    const p = player();
    if (p && typeof p.seekTo === 'function') p.seekTo(ms / 1000, true);
    else { const v = video(); if (v && Number.isFinite(v.duration)) v.currentTime = ms / 1000; }
  }

  // Media events don't bubble; a capturing listener on document also covers a
  // <video> element the site swaps out.
  for (const ev of ['play', 'playing', 'pause', 'waiting', 'seeked', 'durationchange', 'loadedmetadata', 'emptied']) {
    document.addEventListener(ev, (e) => { if (e.target === video()) postState(true); }, true);
  }
  document.addEventListener('yt-navigate-finish', () => postState(true));
  let playerHooked = null;
  function hookPlayer() {
    const p = player();
    if (!p || p === playerHooked || typeof p.addEventListener !== 'function') return;
    playerHooked = p;
    // YT player state 0 = ENDED; more reliable than <video>.ended on MSE.
    try { p.addEventListener('onStateChange', (st) => { if (p === player() && st === 0 && currentId() === expected) markEnded(); }); } catch (e) {}
  }
  // Position heartbeat; cheap when nothing changed (dedupe key).
  setInterval(() => { hookPlayer(); postState(false); }, 1000);

  const ctl = {
    bootId,
    // Return the first state for this play, or let the adapter retry after a full load.
    async play(videoId, positionMs, generation, volume) {
      generationId = generation;
      switching = true;
      expected = videoId;
      holdAfterEnd = false;
      endedEmitted = false;
      lastGood = { positionMs: 0, durationMs: 0 };
      if (currentId() !== videoId) {
        const app = document.querySelector('ytmusic-app');
        let ok = false;
        if (app) {
          app.dispatchEvent(new CustomEvent('yt-navigate', {
            bubbles: true, composed: true,
            detail: { endpoint: { watchEndpoint: { videoId } } },
          }));
          ok = !!(await waitFor(() => currentId() === videoId, 8000));
        }
        if (generationId !== generation) return 'superseded';
        if (!ok) {
          location.assign('https://music.youtube.com/watch?v=' + encodeURIComponent(videoId));
          return 'reloading';
        }
      }
      for (let attempt = 0; ; attempt++) {
        const v = await waitFor(video, attempt === 0 ? 5000 : 1000);
        if (generationId !== generation) return 'superseded';
        if (!v) throw new Error('no video element after navigation');
        if (attempt > 0 && currentId() !== videoId) throw new Error('YouTube Music changed tracks during startup');
        hookPlayer();
        v.volume = Math.max(0, Math.min(1, volume));
        if (positionMs) seekTo(positionMs);
        try {
          await v.play();
          if (generationId !== generation) return 'superseded';
          if (attempt > 0 && currentId() !== videoId) throw new Error('YouTube Music changed tracks during startup');
          if (!isAd()) trackPlayingVideo(v);
          break;
        } catch (e) {
          if (generationId !== generation) return 'superseded';
          // The site's player can interrupt play() as it finishes loading the song.
          if (e?.name !== 'AbortError' || attempt === 2) throw e;
          await sleep(150);
        }
      }
      if (generationId !== generation) return 'superseded';
      switching = false;
      return readState();
    },
    pause() { const v = video(); if (v) v.pause(); postState(true); return true; },
    resume() {
      holdAfterEnd = false;
      const v = video();
      if (v) return v.play().then(() => (postState(true), true));
      return false;
    },
    stop() {
      generationId = null;
      switching = false;
      expected = null;
      holdAfterEnd = false;
      endedEmitted = false;
      const v = video();
      if (v) v.pause();
      return true;
    },
    seek(ms) { endedEmitted = false; holdAfterEnd = false; seekTo(ms); postState(true); return true; },
    next() { const b = playerBar()?.querySelector('.next-button, tp-yt-paper-icon-button[title*="Next"]'); if (b) b.click(); postState(true); return !!b; },
    previous() { const b = playerBar()?.querySelector('.previous-button, tp-yt-paper-icon-button[title*="Previous"]'); if (b) b.click(); postState(true); return !!b; },
    setVolume(x) { const v = video(); if (v) v.volume = Math.max(0, Math.min(1, x)); return true; },
    // true/false from the page config; null while the page hasn't said.
    isSignedIn() {
      const v = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get('LOGGED_IN') : undefined;
      return typeof v === 'boolean' ? v : null;
    },
    getState: readState,
  };
  window.__cadenceCtl = ctl;
  hookPlayer();
  postState(true);
  return true;
})()`;

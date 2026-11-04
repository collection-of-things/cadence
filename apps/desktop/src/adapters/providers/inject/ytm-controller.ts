/**
 * Injected controller for music.youtube.com. Installed via executeJavaScript
 * in the page world. Exposes window.__cadenceCtl for commands and posts player
 * state through window.__cadenceBridge.emit (installed by the provider preload).
 *
 * Strategy follows the Kaset/Pear precedent: drive the real <video> element
 * and the site's own SPA navigation, read state back from the DOM/player.
 * We navigate rather than manipulate the provider queue; on any queue-sync
 * doubt we prefer the correct song and accept a gap — per the v3 doc.
 */

export const YTM_CONTROLLER_JS = String.raw`
(() => {
  if (window.__cadenceCtl) return true;
  const emit = (name, data) => {
    try { window.__cadenceBridge && window.__cadenceBridge.emit(name, data); } catch (e) {}
  };
  const video = () => document.querySelector('video');
  const playerBar = () => document.querySelector('ytmusic-player-bar');
  const nav = () => document.querySelector('ytmusic-navigator') ||
    document.querySelector('ytmusic-app');

  let lastState = null;
  let lastTrackKey = null;

  function readState() {
    const v = video();
    if (!v) return { state: 'idle' };
    const bar = playerBar();
    const title = bar ? (bar.querySelector('.title')?.textContent || '').trim() : '';
    const byline = bar ? (bar.querySelector('.byline')?.textContent || '').trim() : '';
    let state = 'paused';
    if (v.ended) state = 'ended';
    else if (v.readyState < 3 && !v.paused) state = 'buffering';
    else if (!v.paused) state = 'playing';
    return {
      state,
      positionMs: Math.round(v.currentTime * 1000),
      durationMs: Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 0,
      volume: v.volume,
      title,
      byline,
      url: location.href,
    };
  }

  function postState(force) {
    const s = readState();
    const trackKey = s.url + '|' + s.title;
    if (force || JSON.stringify(s) !== lastState || trackKey !== lastTrackKey) {
      lastState = JSON.stringify(s);
      lastTrackKey = trackKey;
      emit('playerState', s);
    }
  }

  const ctl = {
    // Navigate the SPA to a track. Correctness over gaplessness: if provider
    // queue sync cannot be confirmed, we accept the navigation gap.
    async play(videoId, positionMs) {
      const target = 'https://music.youtube.com/watch?v=' + encodeURIComponent(videoId);
      if (!location.href.includes('watch?v=' + videoId)) {
        location.assign(target);
        await new Promise(r => setTimeout(r, 1200));
      }
      const v = video();
      if (!v) throw new Error('no video element after navigation');
      if (positionMs) v.currentTime = positionMs / 1000;
      await v.play().catch(() => {});
      postState(true);
      return true;
    },
    pause() { const v = video(); if (v) v.pause(); postState(true); return true; },
    resume() { const v = video(); if (v) return v.play().then(() => (postState(true), true)); return false; },
    stop() { const v = video(); if (v) { v.pause(); v.currentTime = 0; } postState(true); return true; },
    seek(ms) { const v = video(); if (v && Number.isFinite(v.duration)) v.currentTime = ms / 1000; postState(true); return true; },
    next() { const b = playerBar()?.querySelector('.next-button, tp-yt-paper-icon-button[title*="Next"]'); if (b) b.click(); postState(true); return !!b; },
    previous() { const b = playerBar()?.querySelector('.previous-button, tp-yt-paper-icon-button[title*="Previous"]'); if (b) b.click(); postState(true); return !!b; },
    setVolume(x) { const v = video(); if (v) v.volume = Math.max(0, Math.min(1, x)); return true; },
    isSignedIn() {
      return !!document.querySelector('ytmusic-account-button, a[href*="accounts.google"], img[alt*="Avatar"]') ||
        document.cookie.includes('LOGIN_INFO');
    },
    getState: readState,
  };
  window.__cadenceCtl = ctl;
  setInterval(() => postState(false), 500);
  document.addEventListener('yt-navigate-finish', () => postState(true));
  postState(true);
  return true;
})()`;

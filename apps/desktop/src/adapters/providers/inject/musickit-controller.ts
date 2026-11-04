/**
 * Injected controller for the Apple Music route.
 *
 * Preferred path: MusicKit JS inside music.apple.com (Sidra precedent —
 * MusicKit is already present on that origin). The adapter first tries
 * MusicKit.getInstance(); if the SDK is not configured it configures it with
 * the developer token the app fetched from its token endpoint.
 *
 * Everything degrades honestly: if no developer token exists, the adapter
 * reports 'unauthenticated' and this controller is never installed.
 */

export const MUSICKIT_CONTROLLER_JS = String.raw`
(async (developerToken) => {
  if (window.__cadenceCtl) return true;
  const emit = (name, data) => {
    try { window.__cadenceBridge && window.__cadenceBridge.emit(name, data); } catch (e) {}
  };

  async function waitForMK(tries = 60) {
    for (let i = 0; i < tries; i++) {
      if (window.MusicKit) return window.MusicKit;
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }
  const MK = await waitForMK();
  if (!MK) { emit('error', { message: 'MusicKit JS not present on this page' }); return false; }

  let mk;
  try {
    mk = MK.getInstance();
  } catch (e) {
    if (!developerToken) { emit('needDeveloperToken', {}); return false; }
    mk = await MK.configure({
      developerToken,
      app: { name: 'Cadence', build: '0.1.0' },
    });
  }
  if (!mk) { emit('error', { message: 'MusicKit configure failed' }); return false; }

  let last = '';
  function post(force) {
    const item = mk.nowPlayingItem;
    const s = {
      state: mk.playbackState === MK.PlaybackStates.playing ? 'playing'
        : mk.playbackState === MK.PlaybackStates.paused ? 'paused'
        : mk.playbackState === MK.PlaybackStates.loading
        || mk.playbackState === MK.PlaybackStates.waiting ? 'buffering'
        : mk.playbackState === MK.PlaybackStates.stopped ? 'stopped' : 'idle',
      positionMs: Math.round((mk.currentPlaybackTime || 0) * 1000),
      durationMs: Math.round((item && item.playDuration) || (mk.currentPlaybackDuration * 1000) || 0),
      isAuthorized: mk.isAuthorized,
      nowPlayingId: item ? String(item.id) : null,
      title: item ? item.attributes && item.attributes.name : null,
      artist: item ? item.attributes && item.attributes.artistName : null,
      album: item ? item.attributes && item.attributes.albumName : null,
    };
    const j = JSON.stringify(s);
    if (force || j !== last) { last = j; emit('playerState', s); }
  }

  mk.addEventListener('playbackStateDidChange', () => post(true));
  mk.addEventListener('playbackTimeDidChange', () => post(false));
  mk.addEventListener('nowPlayingItemDidChange', () => post(true));
  mk.addEventListener('authorizationStatusDidChange', () => post(true));

  window.__cadenceCtl = {
    mk,
    async play(songId, positionMs) {
      await mk.setQueue({ song: String(songId) });
      if (positionMs) await mk.seekToTime(positionMs / 1000);
      await mk.play();
      post(true);
      return true;
    },
    pause() { mk.pause(); post(true); return true; },
    resume() { return mk.play().then(() => (post(true), true)); },
    stop() { mk.stop(); post(true); return true; },
    seek(ms) { return mk.seekToTime(ms / 1000).then(() => (post(true), true)); },
    next() { return mk.skipToNextItem().then(() => (post(true), true)); },
    previous() { return mk.skipToPreviousItem().then(() => (post(true), true)); },
    setVolume(x) { mk.volume = Math.max(0, Math.min(1, x)); return true; },
    authorize() { return mk.authorize(); },
    unauthorize() { return mk.unauthorize(); },
    isAuthorized() { return mk.isAuthorized; },
  };
  post(true);
  setInterval(() => post(false), 750);
  return true;
})`;

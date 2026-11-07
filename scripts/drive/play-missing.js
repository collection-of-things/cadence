(async () => {
  const c = window.cadence;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tracks = await c.library.tracks({});
  const t = tracks.find((x) => /long-tone/.test(x.source.path ?? '')) ?? tracks[0];
  const ev = [];
  c.onEvent((e) => { if (e.kind !== 'fft' && e.kind !== 'position') ev.push(JSON.stringify(e).slice(0, 220)); });
  await c.sendCommand({ kind: 'setQueue', items: [{ queueId: 'p1', track: t, origin: { kind: 'manual' } }], startIndex: 0, autoplay: true });
  await wait(3000);
  const s = await c.getSnapshot();
  return { status: s.status, lastError: s.lastError, toasts: [...document.querySelectorAll('.toast')].map((n) => n.textContent), ev };
})()

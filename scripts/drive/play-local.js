(async () => {
  const c = window.cadence;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await c.library.scan([__FOLDER__]);
  await wait(1500);
  const tracks = await c.library.tracks({});
  const events = [];
  c.onEvent((e) => events.push(e.kind === 'snapshot' ? `snapshot:${e.snapshot.status}:${e.snapshot.positionMs}` : e.kind === 'error' ? `error:${JSON.stringify(e)}` : e.kind));
  const t = tracks.find((x) => /tone-440/.test(x.source.path ?? '')) ?? tracks[0];
  const cmd = await c.sendCommand({ kind: 'setQueue', items: [{ queueId: 'p1', track: t, origin: { kind: 'manual' } }], startIndex: 0, autoplay: true });
  await wait(2500);
  const snap = await c.getSnapshot();
  return { trackCount: tracks.length, picked: t && { id: t.id, path: t.source.path, route: t.route }, cmd, status: snap.status, positionMs: snap.positionMs, lastError: snap.lastError, output: snap.output, events: events.slice(0, 30) };
})()

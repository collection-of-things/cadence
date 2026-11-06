(async () => {
  const c = window.cadence;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await c.library.scan([__FOLDER__]);
  await wait(1500);
  const tracks = await c.library.tracks({});
  const t = tracks.find((x) => /long-tone/.test(x.source.path ?? ''));
  const statuses = [];
  c.onEvent((e) => { if (e.kind === 'snapshot') statuses.push(e.snapshot.status + '@' + e.snapshot.positionMs); if (e.kind === 'error' || e.kind === 'toast') statuses.push(JSON.stringify(e)); });
  await c.sendCommand({ kind: 'setQueue', items: [{ queueId: 'p1', track: t, origin: { kind: 'manual' } }], startIndex: 0, autoplay: true });
  const samples = [];
  for (let i = 0; i < 16; i++) { await wait(500); const s = await c.getSnapshot(); samples.push(s.status + ':' + s.positionMs); }
  return { samples, statuses };
})()

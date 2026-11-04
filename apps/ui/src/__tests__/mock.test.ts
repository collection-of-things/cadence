import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorEvent } from '@cadence/protocol';
import { MockCadenceApi } from '../mock/MockCadenceApi';

let api: MockCadenceApi | null = null;
afterEach(() => {
  api?.dispose();
  api = null;
  vi.useRealTimers();
});

describe('MockCadenceApi', () => {
  it('serves a full session: snapshot, queue, capabilities for all routes', async () => {
    api = new MockCadenceApi();
    const [snap, queue, caps] = await Promise.all([api.getSnapshot(), api.getQueue(), api.getCapabilities()]);
    expect(snap.current).not.toBeNull();
    expect(queue.items.length).toBeGreaterThanOrEqual(8);
    expect(caps.map((c) => c.route).sort()).toEqual(
      ['apple-musickit', 'local', 'spotify-librespot', 'spotify-web', 'youtube-music'].sort(),
    );
    expect(caps.some((c) => c.state === 'unauthenticated')).toBe(true);
  });

  it('implements transport commands and emits events', async () => {
    api = new MockCadenceApi();
    const events: CoordinatorEvent[] = [];
    api.onEvent((e) => events.push(e));

    await api.sendCommand({ kind: 'play' });
    await api.sendCommand({ kind: 'pause' });
    await api.sendCommand({ kind: 'resume' });
    await api.sendCommand({ kind: 'seek', positionMs: 60_000 });
    await api.sendCommand({ kind: 'setVolume', volume: 0.4 });
    await api.sendCommand({ kind: 'setRepeat', repeat: 'all' });
    await api.sendCommand({ kind: 'setShuffle', shuffle: true });

    const snap = await api.getSnapshot();
    const queue = await api.getQueue();
    expect(snap.volume).toBe(0.4);
    expect(queue.repeat).toBe('all');
    expect(queue.shuffle).toBe(true);
    expect(queue.shuffleOrder).toHaveLength(queue.items.length);
    expect(events.some((e) => e.kind === 'snapshot')).toBe(true);
    expect(events.some((e) => e.kind === 'queue')).toBe(true);
  });

  it('advances the queue on next', async () => {
    api = new MockCadenceApi();
    const q0 = await api.getQueue();
    const firstId = q0.items[0]!.queueId;
    await api.sendCommand({ kind: 'next' });
    const q1 = await api.getQueue();
    expect(q1.currentIndex).toBe(1);
    const snap = await api.getSnapshot();
    expect(snap.current?.queueId).not.toBe(firstId);
  });

  it('remove/move/insertNext mutate queue truth', async () => {
    api = new MockCadenceApi();
    const q = await api.getQueue();
    const victim = q.items[2]!.queueId;
    await api.sendCommand({ kind: 'remove', queueIds: [victim] });
    await api.sendCommand({ kind: 'move', fromIndex: 0, toIndex: 1 });
    await api.sendCommand({ kind: 'insertNext', items: [{ queueId: 'new-1', track: q.items[0]!.track }] });
    const q2 = await api.getQueue();
    expect(q2.items.find((i) => i.queueId === victim)).toBeUndefined();
    expect(q2.items.find((i) => i.queueId === 'new-1')).toBeDefined();
  });

  it('library search filters by text and returns albums/artists', async () => {
    api = new MockCadenceApi();
    const all = await api.library.tracks({});
    expect(all.length).toBeGreaterThanOrEqual(35);
    const albums = await api.library.albums({});
    const artists = await api.library.artists({});
    expect(albums.length).toBe(5);
    expect(artists.length).toBeGreaterThanOrEqual(5);
    const byAlbum = await api.library.tracks({ album: albums[0]!.title });
    expect(byAlbum.every((t) => t.album === albums[0]!.title)).toBe(true);
    const searched = await api.library.tracks({ text: all[0]!.title.slice(0, 4) });
    expect(searched.length).toBeGreaterThan(0);
  });

  it('scan progress flows through onScanProgress', async () => {
    api = new MockCadenceApi();
    const progress: string[] = [];
    api.library.onScanProgress((p) => progress.push(p.phase));
    await api.library.addFoldersAndScan();
    await new Promise((r) => setTimeout(r, 1600));
    expect(progress).toContain('scanning');
    expect(progress.at(-1)).toBe('watching');
  });
});

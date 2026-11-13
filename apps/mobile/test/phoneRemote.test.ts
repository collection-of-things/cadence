/// <reference types="node" />
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { QueueItem, RemoteClientMessage, TrackRef } from '@cadence/protocol';
import { PhoneRemote, type OwnershipLink, type OwnershipPlayer } from '../src/phoneRemote.ts';

const track: TrackRef = {
  id: 'local:a',
  route: 'local',
  provider: 'local',
  title: 'A',
  artists: [{ name: 'X' }],
  durationMs: 200_000,
  source: { kind: 'file', path: '/a.flac' },
  availability: 'available',
};
const item: QueueItem = { queueId: 'q1', track };

function setup() {
  const sent: RemoteClientMessage[] = [];
  const listeners = new Set<() => void>();
  let state = { active: false, playing: false, positionMs: 0, durationMs: 200_000 };
  let clock = 0;
  const set = (p: Partial<typeof state>) => {
    state = { ...state, ...p };
    for (const cb of listeners) cb();
  };
  const link: OwnershipLink = {
    token: 't',
    sendMessage: (m) => (sent.push(m), true),
    getState: () => ({
      connection: 'online',
      base: 'http://h',
      queue: { owner: 'coordinator', items: [item], currentIndex: 0, shuffle: false, repeat: 'off' },
      snapshot: null,
    }),
  };
  const player = {
    getState: () => state,
    subscribe: (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)),
    start: async () => set({ active: true, playing: false }),
    current: () => (state.active ? item : null),
    volume: () => 1,
    stop: () => set({ active: false, playing: false }),
    pause: () => set({ playing: false }),
    resume: () => set({ playing: true }),
  } as unknown as OwnershipPlayer;
  const notes: string[] = [];
  const remote = new PhoneRemote(link, player, (m) => notes.push(m), () => clock, 20);
  return { remote, sent, set, notes, tick: (ms: number) => (clock += ms), state: () => state };
}

test('a takeover reports only once audio plays, throttles reports, and releases on stop', async () => {
  const t = setup();
  assert.equal(await t.remote.takeOver({ queueId: 'q1', positionMs: 5 }), 'started');
  assert.deepEqual(t.sent, []);
  t.set({ playing: true });
  assert.equal(t.sent.length, 1);
  t.set({ positionMs: 500 });
  assert.equal(t.sent.length, 1);
  t.tick(1000);
  t.set({ positionMs: 1500 });
  assert.equal(t.sent.length, 2);
  t.set({ active: false, playing: false });
  assert.deepEqual(t.sent.at(-1), { kind: 'release' });
});

test('a takeover that never plays gives up without telling the computer', async () => {
  const t = setup();
  await t.remote.takeOver({ queueId: 'q1', positionMs: 0 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.state().active, false);
  assert.deepEqual(t.sent, []);
  assert.equal(t.notes.length, 1);
});

test('a stop control from the computer is always acknowledged with a release', () => {
  const t = setup();
  t.remote.handle({ kind: 'control', command: { kind: 'stop' }, serverNowMs: 0 });
  assert.deepEqual(t.sent, [{ kind: 'release' }]);
});

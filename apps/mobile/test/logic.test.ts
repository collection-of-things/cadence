/// <reference types="node" />
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { QueueState, TrackRef } from '@cadence/protocol';
import { parseManualTarget, parsePairLink } from '../src/pairLink.ts';
import { artworkUri, orderIndexOf, playOrder, providerLink } from '../src/tracks.ts';

const base: TrackRef = {
  id: 'local:a',
  route: 'local',
  provider: 'local',
  title: 'A',
  artists: [{ name: 'X' }],
  durationMs: 1000,
  source: { kind: 'file', path: '/a.flac' },
  availability: 'available',
};

test('parsePairLink reads the desktop QR link', () => {
  const t = parsePairLink('cadence://pair?h=192.168.1.20%2C10.0.0.5&p=47820&c=012345&n=desk');
  assert.deepEqual(t, { hosts: ['192.168.1.20', '10.0.0.5'], port: 47820, code: '012345', name: 'desk' });
  assert.equal(parsePairLink('https://example.com'), null);
  assert.equal(parsePairLink('cadence://pair?h=1.2.3.4&p=47820&c=12'), null);
  assert.equal(parsePairLink('cadence://pair?h=1.2.3.4&p=99999&c=123456'), null);
});

test('parseManualTarget accepts an address with or without a port', () => {
  assert.deepEqual(parseManualTarget('192.168.1.20', '123 456', 47820), {
    hosts: ['192.168.1.20'],
    port: 47820,
    code: '123456',
    name: '192.168.1.20',
  });
  assert.equal(parseManualTarget('192.168.1.20:5000', '123456', 47820)?.port, 5000);
  assert.equal(parseManualTarget('http://x', '123456', 47820), null);
  assert.equal(parseManualTarget('1.2.3.4', '12', 47820), null);
});

test('playOrder follows shuffle order', () => {
  const items = ['a', 'b', 'c'].map((id) => ({ queueId: id, track: { ...base, id } }));
  const q: QueueState = { owner: 'coordinator', items, currentIndex: 2, shuffle: true, shuffleOrder: [2, 0, 1], repeat: 'off' };
  assert.deepEqual(playOrder(q).map((i) => i.queueId), ['c', 'a', 'b']);
  assert.equal(orderIndexOf(q, 'a'), 1);
  assert.deepEqual(playOrder({ ...q, shuffle: false }).map((i) => i.queueId), ['a', 'b', 'c']);
});

test('providerLink maps each service to its app link', () => {
  const sp: TrackRef = { ...base, route: 'spotify-librespot', provider: 'spotify', source: { kind: 'provider', providerItemId: 'id1', uri: 'spotify:track:abc' } };
  assert.equal(providerLink(sp, 0)?.url, 'https://open.spotify.com/track/abc');
  const am: TrackRef = { ...base, route: 'apple-musickit', provider: 'apple', source: { kind: 'provider', providerItemId: 'i.lib', uri: 'am:song:123' } };
  assert.equal(providerLink(am, 0)?.url, 'https://music.apple.com/song/123');
  const amLib: TrackRef = { ...am, source: { kind: 'provider', providerItemId: 'i.lib', uri: 'am:library-song:i.lib' } };
  assert.equal(providerLink(amLib, 0), null);
  const yt: TrackRef = { ...base, route: 'youtube-music', provider: 'youtube', source: { kind: 'provider', providerItemId: 'vid' } };
  assert.equal(providerLink(yt, 61_000)?.url, 'https://music.youtube.com/watch?v=vid&t=61');
  assert.equal(providerLink(base, 0), null);
});

test('artworkUri adds the LAN base and token to server paths', () => {
  const t = { ...base, artwork: { url: '/v1/artwork/local%3Aa' } };
  assert.equal(artworkUri('http://h:1', t, 'tok'), 'http://h:1/v1/artwork/local%3Aa?t=tok');
  assert.equal(artworkUri(null, t, 'tok'), null);
  assert.equal(artworkUri('http://h:1', { ...base, artwork: { url: 'https://x/y.jpg' } }, 'tok'), 'https://x/y.jpg');
});

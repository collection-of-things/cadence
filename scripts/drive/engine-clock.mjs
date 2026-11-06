// Compare cadence-audio's reported position with wall time on the real
// output device (no --null-sink). Usage: node engine-clock.mjs <bin> <file>
import { spawn } from 'node:child_process';

const [bin, file] = process.argv.slice(2);
const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
let rid = 0;
const pending = new Map();
const positions = [];
let t0 = 0;
proc.stderr.on('data', (d) => process.stderr.write('[engine] ' + d));
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'event.position' && t0) positions.push([Date.now() - t0, msg.params.positionMs]);
    else if (msg.method && msg.method !== 'event.fft') console.log('event', msg.method, JSON.stringify(msg.params).slice(0, 160));
  }
});
const send = (method, params = {}) => new Promise((res) => {
  rid += 1;
  pending.set(rid, res);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('load', JSON.stringify(await send('audio.load', { queueId: 'q1', generationId: 1, source: { kind: 'file', path: file } })).slice(0, 300));
t0 = Date.now();
await send('audio.play', { generationId: 1 });
await sleep(14000);
for (const [wall, pos] of positions.filter((_, i) => i % 4 === 0)) console.log(`wall ${wall}ms  pos ${pos}ms  drift ${pos - wall}`);
proc.kill();
process.exit(0);

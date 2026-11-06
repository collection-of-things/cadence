// Drive the real Electron app over the Chrome DevTools Protocol.
//   FOLDER=<music dir> SHOT=<png> node scripts/drive-app.mjs <js-expression-file> [port]
// Launches apps/desktop with --remote-debugging-port, waits for the UI page,
// evaluates the expression (awaiting promises), prints the JSON result and the
// app's stderr, then quits. Used to reproduce real playback without a mouse.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'apps/desktop/package.json'));
const electron = require('electron');
const [exprFile, port = '9333'] = process.argv.slice(2);
// __FOLDER__ in the expression becomes the FOLDER env var (a music folder to scan).
const expr = readFileSync(exprFile, 'utf8').replaceAll('__FOLDER__', JSON.stringify(process.env.FOLDER ?? resolve(root, 'test/fixtures/generated')));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// USER_DATA=<dir> runs beside an already-open Cadence (own lock + library).
const extra = process.env.USER_DATA ? [`--user-data-dir=${process.env.USER_DATA}`] : [];
const app = spawn(electron, ['.', `--remote-debugging-port=${port}`, ...extra], { cwd: resolve(root, 'apps/desktop'), env });
let log = '';
app.stdout.on('data', (d) => (log += d));
app.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === 'page' && t.url.startsWith('cadence-app://'));
  } catch {
    // not up yet
  }
}
if (!target) {
  console.log('UI page never appeared\n--- app log ---\n' + log);
  app.kill();
  process.exit(1);
}
await sleep(2500);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const EVAL_TIMEOUT_MS = 120_000;
const result = await new Promise((res) => {
  // A page that closes or never answers must not leave Electron running.
  const timer = setTimeout(() => {
    console.log(`Runtime.evaluate gave no answer in ${EVAL_TIMEOUT_MS}ms\n--- app log ---\n${log}`);
    app.kill();
    process.exit(1);
  }, EVAL_TIMEOUT_MS);
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id === 1) {
      clearTimeout(timer);
      res(msg.result);
    }
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});
console.log(JSON.stringify(result.result?.value ?? result, null, 2));
// SHOT=<png path>: grab the real screen (native window controls included).
if (process.env.SHOT) {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$img = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($img)',
    '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
    `$img.Save('${process.env.SHOT}')`,
  ].join('; ');
  (await import('node:child_process')).spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
}
ws.close();
app.kill();
await sleep(500);
console.log('--- app log ---\n' + log.split('\n').slice(-40).join('\n'));
process.exit(0);

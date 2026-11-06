// Cross-platform headless capture. Serves apps/ui/dist with vite preview and
// runs apps/desktop/scripts/capture.cjs for each named shot.
//   node scripts/shoot.mjs <outDir> name=<js>[|<w>x<h>] ...
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'apps/desktop/package.json'));
const electron = require('electron');
const port = process.env.CAPTURE_PORT ?? '4517';
const [outDir, ...shots] = process.argv.slice(2);

const preview = spawn('npx', ['vite', 'preview', '--port', port, '--strictPort'], {
  cwd: resolve(root, 'apps/ui'), shell: true, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 2500));
try {
  for (const shot of shots) {
    const eq = shot.indexOf('=');
    const name = eq < 0 ? shot : shot.slice(0, eq);
    let js = eq < 0 ? '' : shot.slice(eq + 1);
    let size = '1600x1000';
    const bar = js.lastIndexOf('|');
    if (bar >= 0 && /^\d+x\d+$/.test(js.slice(bar + 1))) { size = js.slice(bar + 1); js = js.slice(0, bar); }
    const [w, h] = size.split('x');
    const args = [resolve(root, 'apps/desktop/scripts/capture.cjs'),
      `--url=http://localhost:${port}/?cadence_mock=1`, `--out=${resolve(outDir, name + '.png')}`,
      '--wait=2500', `--width=${w}`, `--height=${h}`];
    if (js) args.push(`--eval=${js}`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electron, args, { env, encoding: 'utf8', timeout: 60000 });
    console.log(name, (r.stdout || '').trim(), (r.stderr || '').split('\n').filter((l) => /eval failed/.test(l)).join(' '));
  }
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(preview.pid), '/T', '/F']);
  else preview.kill();
}

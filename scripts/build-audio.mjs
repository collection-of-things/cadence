// Build the Rust audio service (target/<profile>/cadence-audio) so the
// desktop app can play local files. Run by `pnpm dev`; cargo makes repeat
// runs a fast no-op.
//   node scripts/build-audio.mjs [--release]
//
// Windows: cargo needs the MSVC linker. When Visual Studio Build Tools are on
// disk but not registered (vswhere finds nothing), plain cargo fails to link,
// so we retry inside vcvars64.bat.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = ['build', '-p', 'cadence-audio', ...(process.argv.includes('--release') ? ['--release'] : [])];

/** Run a command; spawn failures (e.g. cargo not installed) are reported, not swallowed. */
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', ...opts });
  if (r.error) console.error(`build-audio: could not run ${cmd}: ${r.error.message}`);
  return r;
}

/** Locate vcvars64.bat: vswhere first, then the default install folders. */
function findVcvars() {
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const vswhere = join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const roots = [];
  if (existsSync(vswhere)) {
    const r = spawnSync(vswhere, ['-products', '*', '-latest', '-property', 'installationPath'], { encoding: 'utf8' });
    if (r.stdout?.trim()) roots.push(r.stdout.trim());
  }
  for (const year of ['2022', '2019']) {
    for (const edition of ['BuildTools', 'Community', 'Professional', 'Enterprise']) {
      roots.push(join(pf86, 'Microsoft Visual Studio', year, edition));
      roots.push(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft Visual Studio', year, edition));
    }
  }
  return roots.map((r) => join(r, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')).find(existsSync);
}

// Windows captures the first attempt so a link failure that the vcvars retry
// fixes stays quiet; any other failure prints cargo's own diagnostics.
// maxBuffer: a full cold build's output must not trip Node's 1 MiB default.
const first = run('cargo', args, { stdio: process.platform === 'win32' ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let status = first.status ?? 1;
const replay = () => { process.stdout.write(first.stdout ?? ''); process.stderr.write(first.stderr ?? ''); };
if (status !== 0 && process.platform === 'win32' && first.error) process.exit(1);
if (status !== 0 && process.platform === 'win32') {
  const vcvars = findVcvars();
  if (!vcvars) {
    replay();
    console.error('build-audio: cargo failed and no Visual Studio C++ Build Tools were found.\n' +
      'Install "Desktop development with C++" (Visual Studio Build Tools 2022), then rerun.');
    process.exit(1);
  }
  console.log(`build-audio: retrying inside ${vcvars}`);
  status = run('cmd.exe', ['/d', '/s', '/c', `call "${vcvars}" >nul && cargo ${args.join(' ')}`], { windowsVerbatimArguments: true }).status ?? 1;
}
process.exit(status);

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

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', ...opts }).status ?? 1;

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

let status = run('cargo', args, { stdio: process.platform === 'win32' ? 'pipe' : 'inherit' });
if (status !== 0 && process.platform === 'win32') {
  const vcvars = findVcvars();
  if (!vcvars) {
    console.error('build-audio: cargo failed and no Visual Studio C++ Build Tools were found.\n' +
      'Install "Desktop development with C++" (Visual Studio Build Tools 2022), then rerun.');
    process.exit(1);
  }
  console.log(`build-audio: retrying inside ${vcvars}`);
  status = run('cmd.exe', ['/d', '/s', '/c', `call "${vcvars}" >nul && cargo ${args.join(' ')}`], { windowsVerbatimArguments: true });
}
process.exit(status);

// Minimal Electron shell for captures: serves a built UI dir over a private
// scheme (no server) in an offscreen window sized like the real app.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const dist = path.resolve(arg('dist'));
const width = Number(arg('width', '1440'));
const height = Number(arg('height', '900'));
const query = arg('query', 'cadence_mock=1');

protocol.registerSchemesAsPrivileged([
  { scheme: 'cap', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
app.commandLine.appendSwitch('force-device-scale-factor', arg('scale', '2'));
if (process.env.CAP_NOGRAPHITE) app.commandLine.appendSwitch('disable-features', 'SkiaGraphite');
app.setPath('userData', path.join(require('node:os').tmpdir(), 'cadence-cap-' + process.pid));

app.whenReady().then(async () => {
  protocol.handle('cap', (req) => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    return net.fetch(pathToFileURL(path.join(dist, p)).toString());
  });
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: '#1b1a19',
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: { backgroundThrottling: false },
    paintWhenInitiallyHidden: true,
  });
  // Shown (so layout/visibility are real) but invisible and never focused:
  // the person's desktop is untouched.
  win.setOpacity(Number(process.env.CAP_OPACITY ?? '0'));
  win.setIgnoreMouseEvents(true);
  win.showInactive();
  await win.loadURL(`cap://app/index.html?${query}`);
});

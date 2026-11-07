// Spike: load music.apple.com in an ECS BrowserWindow and report what the
// page gives us for free (MusicKit instance, dev token, storefront, api).
// Run: xvfb-run -a node_modules/electron/dist/electron scripts/am-probe.cjs
const { app, BrowserWindow, session } = require('electron');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-zygote');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ozone-platform', 'headless');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.setPath('userData', '/tmp/cadence-am-probe-' + process.pid);

const EVAL = `(async () => {
  const out = {};
  out.href = location.href;
  out.hasMusicKit = typeof window.MusicKit !== 'undefined';
  out.mkVersion = window.MusicKit ? window.MusicKit.version : null;
  // Wait for MusicKit + a configured instance
  for (let i = 0; i < 40 && !out.hasMusicKit; i++) {
    await new Promise(r => setTimeout(r, 500));
    out.hasMusicKit = typeof window.MusicKit !== 'undefined';
  }
  out.hasMusicKit = typeof window.MusicKit !== 'undefined';
  if (window.MusicKit) {
    out.mkVersion = window.MusicKit.version;
    try {
      const mk = window.MusicKit.getInstance();
      out.gotInstance = true;
      out.isAuthorized = mk.isAuthorized;
      out.storefrontId = mk.storefrontId;
      out.hasApi = !!mk.api;
      out.apiKeys = mk.api ? Object.keys(mk.api) : null;
      out.mkKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(mk)).slice(0, 60);
      // try a catalog api call
      try {
        const api = mk.api && mk.api.v3 ? mk.api.v3 : mk.api;
        const r = await api.music('/v1/catalog/' + mk.storefrontId + '/search', { term: 'daft punk', types: 'songs', limit: 3 });
        out.searchOk = true;
        out.searchSample = JSON.stringify(r).slice(0, 800);
      } catch (e) { out.searchErr = String(e && e.message || e); }
    } catch (e) {
      out.gotInstance = false;
      out.instanceErr = String(e && e.message || e);
      // scrape dev token candidates from the page
      const html = document.documentElement.innerHTML;
      const m = html.match(/"token"\\s*:\\s*"(eyJ[^"]+)"/);
      out.scrapedToken = m ? m[1].slice(0, 40) + '…' : null;
      const scripts = [...document.scripts].map(s => s.src).filter(Boolean);
      out.scripts = scripts.slice(0, 12);
    }
  }
  out.widevine = await (async () => {
    try {
      const cfg = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
        initDataTypes: ['cenc'],
        audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }],
      }]);
      return cfg.getConfiguration ? 'yes' : 'yes';
    } catch (e) { return 'no: ' + String(e && e.message || e); }
  })();
  return out;
})()`;

async function main() {
  await app.whenReady();
  const components = app.components;
  if (components) {
    try { await components.whenReady(); console.log('COMPONENTS ready'); }
    catch (e) { console.log('COMPONENTS failed', String(e)); }
  }
  console.log('ELECTRON', process.versions.electron, 'CHROME', process.versions.chrome);
  const ses = session.fromPartition('persist:probe-apple');
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: { session: ses, sandbox: true, contextIsolation: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log('[page]', m.slice(0, 200)));
  await win.loadURL('https://music.apple.com/us/browse');
  // give SPA time to boot MusicKit
  await new Promise(r => setTimeout(r, 20000));
  const out = await win.webContents.executeJavaScript(EVAL, true).catch(e => ({ evalErr: String(e) }));
  console.log(JSON.stringify(out, null, 1));
  app.quit();
}
void main();

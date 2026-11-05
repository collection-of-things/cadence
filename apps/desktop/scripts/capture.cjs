// Headless screenshot capture for the UI. Run under xvfb-run:
//   electron scripts/capture.cjs --url=... --out=shot.png --wait=2500 [--eval=js]
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('ozone-platform', 'x11');
app.setPath('userData', '/tmp/cadence-cap-' + process.pid);
const { writeFileSync, mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

async function main() {
  const args = process.argv.slice(1);
  const get = (k, d) => {
    const a = args.find((x) => x.startsWith(`--${k}=`));
    return a ? a.slice(k.length + 3) : d;
  };
  const url = get('url', 'http://localhost:4517/?cadence_mock=1');
  const out = resolve(get('out', 'shot.png'));
  const wait = parseInt(get('wait', '2500'), 10);
  const evalJs = get('eval', null);
  const width = parseInt(get('width', '1440'), 10);
  const height = parseInt(get('height', '900'), 10);

  await app.whenReady();
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, wait));
  if (evalJs) {
    await win.webContents.executeJavaScript(evalJs, true)
      .catch((e) => console.warn('eval failed:', e.message));
    await new Promise((r) => setTimeout(r, 1200));
  }
  const img = await win.webContents.capturePage();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, img.toPNG());
  console.log(`captured ${out} (${img.getSize().width}x${img.getSize().height})`);
  app.quit();
}
void main();

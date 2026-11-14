import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const env = { ...process.env };
// These settings belong to a parent Electron app, not to Cadence.
delete env.ELECTRON_RUN_AS_NODE;
delete env.CHROME_DESKTOP;

const result = spawnSync(require("electron"), [".", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);

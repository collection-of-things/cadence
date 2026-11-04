import { defineConfig } from "tsup";

/**
 * Main and preload are bundled to CommonJS: preload scripts cannot be ESM
 * under a sandboxed renderer, and CJS main keeps startup identical across
 * stock Electron and Castlabs ECS.
 */
export default defineConfig({
  entry: {
    main: "src/main.ts",
    preload: "src/preload.ts",
    "provider-preload": "src/adapters/providers/provider-preload.ts",
  },
  outDir: "dist",
  format: ["cjs"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  splitting: false,
  // Native + runtime-provided modules must not be bundled.
  external: ["electron", "better-sqlite3"],
});

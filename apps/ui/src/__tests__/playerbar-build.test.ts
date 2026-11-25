import { build } from 'vite';
import { expect, it } from 'vitest';

/** The production stylesheet, as Vite's minifier emits it. */
async function builtCss(): Promise<string> {
  const result = await build({ logLevel: 'silent', build: { write: false } });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs
    .flatMap((bundle) => ('output' in bundle ? bundle.output : []))
    .flatMap((asset) => (asset.type === 'asset' && asset.fileName.endsWith('.css') ? [asset.source.toString()] : []))
    .join('\n');
}

it('preserves the player bar backdrop blur in the production stylesheet', async () => {
  const css = await builtCss();
  expect(/\.playerbar\s*\{(?:[^}]*;)?\s*backdrop-filter:\s*blur\(/.test(css)).toBe(true);
});

it('keeps the standard backdrop-filter on every glass surface', async () => {
  // The minifier keeps only the last of `backdrop-filter` and its -webkit-
  // twin when both are written, and Chromium ignores the prefixed one, so a
  // source rule that lists both loses its blur in the built app.
  const css = await builtCss();
  const rules = css.split('}').filter((rule) => rule.includes('-webkit-backdrop-filter'));
  const prefixedOnly = rules.filter((rule) => !/[;{]\s*backdrop-filter\s*:/.test(rule));
  expect(prefixedOnly.map((rule) => rule.slice(0, rule.indexOf('{')).trim())).toEqual([]);
});

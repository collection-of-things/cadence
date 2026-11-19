import { build } from 'vite';
import { expect, it } from 'vitest';

it('preserves the player bar backdrop blur in the production stylesheet', async () => {
  const result = await build({ logLevel: 'silent', build: { write: false } });
  const outputs = Array.isArray(result) ? result : [result];

  const playerBarHasBlur = outputs.some((bundle) => 'output' in bundle && bundle.output.some((asset) =>
    asset.type === 'asset' && asset.fileName.endsWith('.css') &&
    /\.playerbar\s*\{(?:[^}]*;)?\s*backdrop-filter:\s*blur\(/.test(asset.source.toString()),
  ));

  expect(playerBarHasBlur).toBe(true);
});

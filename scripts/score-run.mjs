import { build } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

await build({
  entryPoints: ['src/ai/score-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'work/eval-score.mjs',
  packages: 'external',
});
await import(pathToFileURL(path.resolve('work/eval-score.mjs')).href);

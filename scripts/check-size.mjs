// Bundle-size gate: minifies the library (core + plugins + custom element,
// one ES module) and fails if it exceeds the budgets below. Budgets sit ~10%
// above the current measured size so growth is a deliberate decision, not
// accidental drift. Raise them here, in the same commit as the feature.

import { build } from 'esbuild';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const BUDGETS = {
  minified: 24_576, // 24 KB (measured 2026-08: 22,279 B)
  gzip: 8_192,      //  8 KB (measured 2026-08:  7,336 B)
};

const { outputFiles } = await build({
  entryPoints: ['src/chromakey.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  write: false,
});

const code = outputFiles[0].contents;
const sizes = {
  minified: code.length,
  gzip: gzipSync(code, { level: 9 }).length,
  brotli: brotliCompressSync(code, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
};

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
let failed = false;
for (const [name, size] of Object.entries(sizes)) {
  const budget = BUDGETS[name];
  const status = budget === undefined ? 'info' : size <= budget ? 'ok' : 'OVER BUDGET';
  if (status === 'OVER BUDGET') failed = true;
  console.log(
    `${name.padEnd(9)} ${kb(size).padStart(9)} (${size} B)` +
    (budget ? `  budget ${kb(budget)}  [${status}]` : `  [${status}]`),
  );
}

process.exit(failed ? 1 : 0);

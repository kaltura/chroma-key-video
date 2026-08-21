// Ingest a bench-result GitHub issue into bench-results-devices.jsonl and
// regenerate DEVICES.md. Run by .github/workflows/bench-results.yml with the
// issue payload in the ISSUE_JSON env var.
//
// Issue bodies are untrusted input that ends up in committed files, so this
// script validates the payload shape strictly, whitelists every field it
// stores, and sanitizes every string that lands in markdown. Exit codes:
// 0 = ingested (or duplicate — a comment file says which), 1 = invalid
// payload (error written to the comment file, issue stays open for edits).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const JSONL = 'bench-results-devices.jsonl';
const DEVICES_MD = 'DEVICES.md';
const COMMENT_FILE = 'ingest-comment.md'; // workflow posts this back and deletes it
const MAX_BODY = 64 * 1024;
const MAX_RUNS = 10;

const NUMERIC_RUN_FIELDS = [
  'webglKeyMs', 'webglDissolveMs', 'cpuKeyMs', 'autoTuneMs', 'fps1',
  'fpsEachOf12Min', 'fpsEachOf12Max', 'longFramesOf120', 'worstFrameMs',
  'backgroundAlpha',
];
const STRING_RUN_FIELDS = ['source', 'renderer', 'backend', 'cpuBackend', 'outputSize'];

// Strip anything that could break out of a markdown table cell or smuggle
// links/HTML into the committed files.
const clean = (v, max = 200) =>
  String(v).replace(/[|`<>[\]\n\r\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(3) : null);

function fail(msg) {
  writeFileSync(COMMENT_FILE,
    `Could not ingest this benchmark result: ${msg}\n\n` +
    `Edit the issue so the **Results JSON** field contains exactly the JSON from the ` +
    `bench page's "Copy JSON" button — the bot re-runs on every edit.\n`);
  console.error(`invalid payload: ${msg}`);
  process.exit(1);
}

function extractPayload(body) {
  // The issue form renders the results field as a fenced ```json block.
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (!m) fail('no fenced ```json block found in the issue body');
  if (m[1].length > MAX_BODY) fail(`results JSON exceeds ${MAX_BODY} bytes`);
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    fail(`results block is not valid JSON (${e.message})`);
  }
}

function validate(payload) {
  if (!payload || typeof payload !== 'object') fail('payload is not an object');
  const d = payload.device;
  if (!d || typeof d.userAgent !== 'string' || !d.userAgent) fail('device.userAgent missing');
  if (!Array.isArray(payload.runs) || payload.runs.length === 0) fail('runs[] missing or empty');
  if (payload.runs.length > MAX_RUNS) fail(`more than ${MAX_RUNS} runs`);

  const device = {
    userAgent: clean(d.userAgent, 300),
    platform: clean(d.platform || '', 60),
    hardwareConcurrency: num(d.hardwareConcurrency),
    deviceMemory: num(d.deviceMemory),
    devicePixelRatio: num(d.devicePixelRatio),
    screen: clean(d.screen || '', 20),
  };
  const runs = payload.runs.map((r, i) => {
    const run = {};
    for (const f of STRING_RUN_FIELDS) run[f] = clean(r[f] ?? '', 120);
    for (const f of NUMERIC_RUN_FIELDS) {
      run[f] = num(r[f]);
      if (run[f] === null) fail(`runs[${i}].${f} is not a finite number`);
    }
    return run;
  });
  return { device, runs };
}

// Human-readable browser name from the UA string — heuristic, display-only.
function browserFromUA(ua) {
  let m;
  if ((m = /Firefox\/(\d+)/.exec(ua))) return `Firefox ${m[1]}`;
  if ((m = /Edg\/(\d+)/.exec(ua))) return `Edge ${m[1]}`;
  if ((m = /OPR\/(\d+)/.exec(ua))) return `Opera ${m[1]}`;
  if ((m = /Chrome\/(\d+)/.exec(ua))) return `Chrome ${m[1]}`;
  if (/Safari\//.test(ua) && (m = /Version\/(\d+)/.exec(ua))) return `Safari ${m[1]}`;
  return 'unknown';
}

function loadRecords() {
  if (!existsSync(JSONL)) return [];
  return readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function renderDevicesMd(records) {
  const header =
    '# Device Benchmark Results\n\n' +
    'Community-submitted results from the [self-service bench page]' +
    '(https://kaltura.github.io/chroma-key-video/test/bench.html). ' +
    'Each row is one benchmark run (a submission may include a synthetic run ' +
    'and a real-footage run). Key/dissolve/CPU are per-frame render cost at ' +
    '1280x720; fps x12 is the per-player range with 12 concurrent players.\n\n' +
    'Run it on your device and share your numbers — the **Share results** ' +
    'button on the bench page files them here automatically.\n\n';
  if (records.length === 0) return header + '_No results yet — be the first!_\n';

  const cols = '| Date | Platform | Browser | GPU | Source | Backend | Key ms | +Dissolve ms | CPU ms | fps x1 | fps x12 | Jank /120 | Issue |\n' +
               '|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  const rows = [];
  for (const rec of [...records].reverse()) {
    for (const run of rec.runs) {
      const src = run.source.startsWith('synthetic') ? 'synthetic' : 'footage';
      rows.push(`| ${rec.submittedAt.slice(0, 10)} | ${rec.device.platform || '?'} | ` +
        `${browserFromUA(rec.device.userAgent)} | ${run.renderer || '?'} | ${src} | ` +
        `${run.backend} | ${run.webglKeyMs} | ${run.webglDissolveMs} | ${run.cpuKeyMs} | ` +
        `${run.fps1} | ${run.fpsEachOf12Min}-${run.fpsEachOf12Max} | ${run.longFramesOf120} | ` +
        `[#${rec.issue}](https://github.com/kaltura/chroma-key-video/issues/${rec.issue}) |`);
    }
  }
  return header + cols + rows.join('\n') + '\n';
}

// ── main ──────────────────────────────────────────────────────────────────

const issue = JSON.parse(process.env.ISSUE_JSON || 'null');
if (!issue || !issue.number || typeof issue.body !== 'string') {
  fail('workflow did not provide an issue payload');
}

const { device, runs } = validate(extractPayload(issue.body));
const hash = createHash('sha256').update(JSON.stringify({ device, runs })).digest('hex').slice(0, 16);

const records = loadRecords();
if (records.some((r) => r.hash === hash)) {
  writeFileSync(COMMENT_FILE,
    'These exact results are already in [DEVICES.md](../blob/main/DEVICES.md) — ' +
    'closing as a duplicate. Thanks for benchmarking!\n');
  console.log('duplicate — nothing to ingest');
  process.exit(0);
}

records.push({
  issue: issue.number,
  submittedAt: new Date().toISOString(),
  hash,
  device,
  runs,
});

writeFileSync(JSONL, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(DEVICES_MD, renderDevicesMd(records));
writeFileSync(COMMENT_FILE,
  `Ingested ${runs.length} run(s) — your device is now in ` +
  '[DEVICES.md](../blob/main/DEVICES.md). Thanks for benchmarking!\n');
console.log(`ingested issue #${issue.number}: ${runs.length} run(s), hash ${hash}`);

// Minimal static file server for the e2e suite and demo. Zero dependencies.
// Also accepts POST /bench-results from test/bench.html and appends each
// payload to bench-results-local.jsonl (gitignored) — a local collector for
// benching devices on your own network. Public collection goes through
// GitHub issues instead (see .github/ISSUE_TEMPLATE/bench-result.yml).
import { createServer } from 'node:http';
import { appendFile, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/bench-results') {
      let body = '';
      for await (const chunk of req) body += chunk;
      JSON.parse(body); // non-JSON falls through to the catch below
      await appendFile(join(root, 'bench-results-local.jsonl'), body.replace(/\n/g, '') + '\n');
      res.writeHead(204);
      res.end();
      console.log('bench result collected -> bench-results-local.jsonl');
      return;
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => {
  console.log(`serving ${root} on http://localhost:${port}`);
});

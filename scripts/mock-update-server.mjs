// Dev-only fake update feed for manually exercising the full download -> safe-moment wait ->
// relaunch -> resume pipeline against a real packaged build (`npm run dist`), without needing a
// real GitHub release. Not run by `npm run check` or CI: quitAndInstall() against a dummy
// installer still needs a human watching a real installed copy, same as anything else under
// "Untested against the live game" in the README.
//
// Usage: node scripts/mock-update-server.mjs [--version 9.9.9] [--port 8991]
// Then point a packaged build at it: SEXYVAL_UPDATE_FEED_URL=http://127.0.0.1:8991 (the exe).
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const version = args.version || '9.9.9';
const port = Number(args.port) || 8991;
const dir = path.join(os.tmpdir(), 'sexyval-mock-update');
const installerName = `SexyVal-Setup-${version}.exe`;

async function ensureFixture() {
  await fs.mkdir(dir, { recursive: true });
  const installerPath = path.join(dir, installerName);
  // Content doesn't need to be a real installer to exercise check -> download -> verify -> 'update-downloaded';
  // electron-updater only checks the sha512/size in latest.yml match what it downloaded.
  const bytes = crypto.randomBytes(2 * 1024 * 1024);
  await fs.writeFile(installerPath, bytes);
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  const yml = [`version: ${version}`, `files:`, `  - url: ${installerName}`, `    sha512: ${sha512}`, `    size: ${bytes.length}`, `path: ${installerName}`, `sha512: ${sha512}`, `releaseDate: '${new Date().toISOString()}'`].join('\n');
  await fs.writeFile(path.join(dir, 'latest.yml'), yml);
  return installerPath;
}

async function main() {
  const installerPath = await ensureFixture();
  const server = http.createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '/').replace(/^\//, '') || 'latest.yml');
    try {
      const body = await fs.readFile(path.join(dir, name));
      res.writeHead(200, { 'content-type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream', 'content-length': body.length });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, () => {
    console.log(`mock update feed: http://127.0.0.1:${port} (version ${version})`);
    console.log(`fake installer: ${installerPath}`);
    console.log(`point a packaged build at it: set SEXYVAL_UPDATE_FEED_URL=http://127.0.0.1:${port} before launching the installed exe`);
  });
}

void main();

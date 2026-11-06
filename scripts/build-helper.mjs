// Builds helper/stretch.exe with the C# compiler that ships with Windows (.NET Framework 4.x), so no SDK
// is needed. Skips when the exe is newer than the source. Unsigned.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const src = path.join(root, 'helper', 'stretch.cs');
const out = path.join(root, 'helper', 'stretch.exe');
const windir = process.env.WINDIR ?? 'C:\\Windows';
const csc = [path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find((p) => fs.existsSync(p));

if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(src).mtimeMs && !process.argv.includes('--force')) {
  console.log('helper/stretch.exe is up to date');
  process.exit(0);
}
if (!csc) {
  console.error('csc.exe (.NET Framework 4) not found; helper/stretch.exe not rebuilt');
  process.exit(process.platform === 'win32' ? 1 : 0);
}
execFileSync(csc, ['/nologo', '/optimize+', '/platform:anycpu', '/target:exe', `/out:${out}`, src], { stdio: 'inherit' });
console.log(`built ${path.relative(root, out)}`);

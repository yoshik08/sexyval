// Launch Electron with KEY=VALUE env args. Strips ELECTRON_RUN_AS_NODE (set by VS Code terminals),
// which would otherwise make Electron run as plain Node.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const arg of process.argv.slice(2)) {
  const i = arg.indexOf('=');
  if (i > 0) env[arg.slice(0, i)] = arg.slice(i + 1);
}
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));

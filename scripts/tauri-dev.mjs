// `npm run tauri:dev` — run the desktop app from this checkout without
// colliding with the installed app or with dev runs in other worktrees.
//
// Per checkout it picks:
//   - a free dev-server port (from 1420 up), passed to Vite and to Tauri's devUrl
//   - its own bundle identifier, so the single-instance lock, window state and
//     logs are separate from the installed app and from other worktrees
//   - a sandbox home at <checkout>/.dev-home (see src-tauri/src/core/dev_home.rs),
//     so the library, database, config and agent skill dirs are not your real ones
//
// Options (after `--`, e.g. `npm run tauri:dev -- --real-home`):
//   --real-home   use your real home: real library, real agents, real backup.
//                 Branch code can migrate the real database past what the
//                 installed app can open.
// Anything else is passed through to `tauri dev`.
//
// Environment overrides: SKILLS_MANAGER_DEV_PORT, SKILLS_MANAGER_DEV_HOME.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);

const args = process.argv.slice(2);
const realHome = args.includes('--real-home');
const passthrough = args.filter((arg) => arg !== '--real-home');

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  const fixed = Number(process.env.SKILLS_MANAGER_DEV_PORT);
  if (fixed) return fixed;
  for (let port = 1420; port < 1520; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('no free dev port in 1420-1519; set SKILLS_MANAGER_DEV_PORT');
}

const port = await pickPort();
const identifier = `com.agentskills.desktop.dev.w${hash}`;

const env = { ...process.env, SKILLS_MANAGER_DEV_PORT: String(port) };
let homeLabel;
if (realHome) {
  delete env.SKILLS_MANAGER_DEV_HOME;
  homeLabel = 'REAL home (real library, agents and backup)';
} else {
  env.SKILLS_MANAGER_DEV_HOME = path.resolve(env.SKILLS_MANAGER_DEV_HOME || path.join(root, '.dev-home'));
  mkdirSync(env.SKILLS_MANAGER_DEV_HOME, { recursive: true });
  homeLabel = env.SKILLS_MANAGER_DEV_HOME;
}

// Passed as a file rather than inline JSON so Windows shell quoting can't mangle it.
const overridePath = path.join(tmpdir(), `skills-manager-dev-${hash}.json`);
writeFileSync(
  overridePath,
  JSON.stringify({ identifier, build: { devUrl: `http://127.0.0.1:${port}` } }, null, 2),
);

console.log(`skills-manager dev
  checkout:   ${root}
  port:       ${port}
  identifier: ${identifier}
  home:       ${homeLabel}
`);

const tauri = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const child = spawn(
  tauri,
  ['dev', '--config', 'src-tauri/tauri.dev.conf.json', '--config', overridePath, ...passthrough],
  { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' },
);
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

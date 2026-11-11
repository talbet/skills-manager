// `npm run worktree:setup` — make a fresh git worktree ready to build.
//
// 1. `npm ci` if node_modules is missing.
// 2. Seed src-tauri/target from the main checkout as a copy-on-write clone, so
//    the first Rust build recompiles only this crate (~40s) instead of every
//    dependency. The clone shares disk blocks with the original until either
//    side changes, and each worktree keeps its own target dir, so concurrent
//    builds don't block on each other's cargo lock.
//
// Cloning needs APFS (macOS) or a reflink filesystem (btrfs/XFS on Linux).
// Elsewhere the target step is skipped rather than copying gigabytes.
// Safe to re-run: steps whose output already exists are skipped.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function mainCheckout() {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const first = out.split('\n').find((line) => line.startsWith('worktree '));
  return first ? path.resolve(first.slice('worktree '.length)) : null;
}

if (existsSync(path.join(root, 'node_modules'))) {
  console.log('node_modules: present, skipping npm ci');
} else {
  console.log('node_modules: running npm ci');
  if (!run('npm', ['ci', '--no-audit', '--no-fund'])) process.exit(1);
}

const target = path.join(root, 'src-tauri', 'target');
const main = mainCheckout();
const source = main && path.join(main, 'src-tauri', 'target');

if (existsSync(target)) {
  console.log('src-tauri/target: present, skipping clone');
} else if (!main || main === root) {
  console.log('src-tauri/target: this is the main checkout, nothing to clone from');
} else if (!existsSync(source)) {
  console.log(`src-tauri/target: ${source} does not exist yet, skipping clone`);
} else {
  const cloneArgs =
    process.platform === 'darwin'
      ? ['-cR', source, target]
      : process.platform === 'linux'
        ? ['-R', '--reflink=always', source, target]
        : null;
  if (!cloneArgs) {
    console.log('src-tauri/target: copy-on-write clone not supported on this platform, skipping');
  } else {
    console.log(`src-tauri/target: cloning from ${source}`);
    if (!run('cp', cloneArgs)) {
      rmSync(target, { recursive: true, force: true });
      console.log('src-tauri/target: clone failed (filesystem without copy-on-write?), skipped');
    }
  }
}

import { spawnSync } from 'node:child_process';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('.', import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: project, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed.`);
}

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Setup requires Node.js 22 or newer.');
  run('npm', ['ci']);
  const { findChromium } = await import('./open-browser.mjs');
  if (!findChromium()) {
    if (process.env.DUET_CHROME) throw new Error('DUET_CHROME must point to a Chromium executable.');
    run(process.execPath, [join(project, 'node_modules/playwright-core/cli.js'), 'install', 'chromium', '--no-shell']);
  }

  const bin = resolve(process.env.DUET_BIN_DIR ?? join(homedir(), '.local', 'bin'));
  const launcher = await realpath(join(project, 'claude-duet-menu'));
  const target = join(bin, 'claude-duet-menu');
  await mkdir(bin, { recursive: true });
  try { await symlink(launcher, target); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await realpath(target).catch(() => null) !== launcher) throw new Error(`A different launcher is already installed at ${target}.`);
  }
  const { loadHost, setupHost } = await import('./mcp-host.mjs');
  if (process.stdin.isTTY && !await loadHost().catch(() => null)) await setupHost();
  console.log(`Installed ${target}\nRun claude-duet-menu and type /duet:proxy to sign in or enable Duet.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

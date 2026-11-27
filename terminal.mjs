import { spawn as run } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node-pty';
import { defaultMcpPort, httpsHost, loadHost, saveHost } from './mcp-host.mjs';
import { startRuntime, workspaceDirectory } from './runtime.mjs';

const plugin = fileURLToPath(new URL('./plugin', import.meta.url));
const args = process.argv.slice(2);
const originalEnv = { ...process.env };
const binary = originalEnv.DUET_CLAUDE_BIN || 'claude';
const write = text => process.stdout.write(text);

const startupOnly = new Set(['--continue', '-c', '--resume', '-r', '--session-id', '--fork-session', '--from-pr', '--worktree', '-w', '--tmux']);
const optionalValue = new Set(['--resume', '-r', '--from-pr', '--worktree', '-w', '--remote-control', '--debug', '-d', '--prompt-suggestions']);
const requiredValue = new Set(['--session-id', '--agent', '--agents', '--append-system-prompt', '--autocompact', '--debug-file', '--effort',
  '--fallback-model', '--model', '--name', '-n', '--permission-mode', '--permission-prompts', '--plugin-dir', '--plugin-url',
  '--remote-control-session-name-prefix', '--setting-sources', '--settings', '--system-prompt', '--system-prompt-snapshot']);
const manyValues = new Set(['--add-dir', '--allowedTools', '--allowed-tools', '--betas', '--disallowedTools', '--disallowed-tools', '--mcp-config', '--tools']);

function resumeOptions(args) {
  const options = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-') || arg === '--') break;
    const key = arg.split('=')[0];
    const part = [arg];
    if (key === arg) {
      if (requiredValue.has(key) && args[index + 1] !== undefined) part.push(args[++index]);
      if (optionalValue.has(key) && args[index + 1] && !args[index + 1].startsWith('-')) part.push(args[++index]);
      if (manyValues.has(key)) while (args[index + 1] !== undefined && !args[index + 1].startsWith('-')) part.push(args[++index]);
    }
    if (!startupOnly.has(key)) options.push(...part);
  }
  return options;
}

function processEnvironment(runtime, directory) {
  const env = { ...originalEnv, DUET_TERMINAL_STATE: directory };
  if (!runtime) return env;
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_AWS', 'CLAUDE_CODE_USE_AWS_BEDROCK']) delete env[key];
  const noProxy = `127.0.0.1,localhost${env.NO_PROXY ? ',' + env.NO_PROXY : ''}`;
  Object.assign(env, { ANTHROPIC_BASE_URL: runtime.endpoint, ANTHROPIC_AUTH_TOKEN: runtime.token,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_PROXY: noProxy, no_proxy: noProxy });
  return env;
}

const routes = ['Claude', 'Duet with workspace tools', 'Sign in to Duet', 'Cancel'];
const color = !('NO_COLOR' in originalEnv) && originalEnv.TERM !== 'dumb';
const accent = color ? '\x1b[38;5;173m' : '';
const dim = color ? '\x1b[2m' : '';
const bold = color ? '\x1b[1m' : '';
const reset = color ? '\x1b[0m' : '';

async function choose(menu, root, current, transport) {
  let selected = current;
  return new Promise(resolve => {
    const paint = () => {
      write(`\x1b[2J\x1b[H\x1b[?25l\r\n  ${accent}${bold}Duet proxy${reset}\r\n\r\n`);
      routes.forEach((label, index) => {
        const unavailable = index === 1 && !root && current !== 1 ? ' (directory unavailable)' : '';
        const cursor = index === selected ? `${accent}❯${reset}` : ' ';
        const state = index === current ? ` ${dim}· active${reset}` : '';
        write(`  ${cursor} ${dim}${index + 1}.${reset} ${index === selected ? bold : ''}${label}${reset}${unavailable}${state}\r\n`);
      });
      if (root) {
        write(`\r\n  ${dim}Workspace${reset}  ${root.replace(/[\x00-\x1f\x7f]/g, '?')}\r\n`);
        write(`  ${dim}Connection${reset} ${transport}\r\n`);
      } else write('  Claude Code’s current directory is unavailable for workspace tools.\r\n');
      write(`\r\n  ${dim}↑↓ navigate  ·  Enter select  ·  Esc cancel${reset}\r\n`);
    };
    menu.input = data => {
      if (data === '\x1b' || data === '\x03') return resolve(3);
      if (data === '\x1b[A' || data === 'k') selected = (selected + routes.length - 1) % routes.length;
      else if (data === '\x1b[B' || data === 'j') selected = (selected + 1) % routes.length;
      else if (/^[1-4]\r?$/.test(data)) return resolve(Number(data[0]) - 1);
      else if (data === '\r' || data === '\n') return resolve(selected);
      paint();
    };
    paint();
  });
}

function menuInput(menu, signal, receive) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    menu.input = data => {
      if (data === '\x1b' || data === '\x03') return finish(new Error('Switch canceled.'));
      receive(data, value => finish(null, value));
    };
  });
}

function inputText(menu, signal, label) {
  let value = '';
  const paint = () => write(`\r\x1b[2K  ${label} ${value}`);
  paint();
  return menuInput(menu, signal, (data, done) => {
    const normal = data.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
    const submitted = /[\r\n]$/.test(normal);
    const addition = normal.replace(/[\r\n]+$/, '');
    if (data === '\x7f' || data === '\b') value = [...value].slice(0, -1).join('');
    else if (data === '\x15') value = '';
    else if (!/[\x00-\x1f\x7f]/.test(addition)) value = (value + addition).slice(0, 2048);
    if (submitted) { write('\r\n'); return done(value.trim()); }
    paint();
  });
}

async function chooseHost(menu, signal) {
  write(`\x1b[2J\x1b[H\x1b[?25h\r\n  ${accent}${bold}Local Workspace host${reset}\r\n\r\n`);
  write('  Use your own public HTTPS endpoint on port 443. Esc cancels.\r\n\r\n');
  while (true) {
    try {
      const url = await inputText(menu, signal, 'Public MCP URL');
      const port = (await inputText(menu, signal, `Local forwarding port [${defaultMcpPort}]`)) || defaultMcpPort;
      const host = await saveHost(httpsHost(url, port));
      write(`  Forward ${host.url} to http://127.0.0.1:${host.port}/mcp.\r\n`);
      return host;
    } catch (error) {
      if (signal.aborted || error.message === 'Switch canceled.') throw error;
      write(`  ${error.message}\r\n`);
    }
  }
}

async function direct() {
  const child = run(binary, args, { stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

async function interactive() {
  const directory = await mkdtemp(join(tmpdir(), 'duet-terminal-'));
  const menuFile = join(directory, 'menu.json');
  const previousRaw = process.stdin.isRaw;
  let active, runtime, menu, setup, finishing = false;
  const carriedOptions = resumeOptions(args);
  const parseRequest = async () => {
    let request;
    try { request = JSON.parse(await readFile(menuFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    await rm(menuFile, { force: true });
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(request.session ?? '') ||
        typeof request.cwd !== 'string') throw new Error('Claude Code did not report a resumable session.');
    return request;
  };

  function launch(options, cwd) {
    const pty = spawn(binary, ['--plugin-dir', plugin, ...options], { cwd, env: processEnvironment(runtime, directory),
      name: originalEnv.TERM || 'xterm-256color', cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    const state = { pty, switching: false, exited: false, output: '' };
    active = state;
    pty.onData(data => {
      if (menu && active === state) state.output = (state.output + data).slice(-256 * 1024);
      else if (active === state) write(data);
    });
    state.exit = new Promise(resolve => pty.onExit(event => {
      state.exited = true;
      resolve(event);
      if (active === state && !state.switching) void finish(event.exitCode);
    }));
  }

  function closeMenu(showBuffered = true) {
    if (!menu) return;
    menu = undefined;
    write('\x1b[?25h\x1b[?1049l');
    if (showBuffered && active?.output) write(active.output);
    if (active) active.output = '';
    if (showBuffered && active && !active.exited) {
      active.pty.resize((process.stdout.columns || 80) + 1, process.stdout.rows || 24);
      setTimeout(onResize, 100).unref();
    }
  }

  async function finish(code) {
    if (finishing) return;
    finishing = true;
    setup?.abort();
    clearInterval(watcher);
    closeMenu();
    process.stdin.off('data', onInput);
    process.stdout.off('resize', onResize);
    process.stdin.setRawMode(previousRaw);
    process.stdin.pause();
    if (active && !active.exited) active.pty.kill();
    await runtime?.stop();
    await rm(directory, { recursive: true, force: true });
    process.exitCode = code ?? 0;
  }

  const onInput = data => {
    if (menu) return menu.input(data.toString());
    if (!active?.exited) active?.pty.write(data.toString());
  };
  const onResize = () => {
    if (active && !active.exited) active.pty.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  };

  async function switchRoute(request) {
    if (finishing || !active || active.exited) return;
    menu = { input: () => {} };
    active.output = '';
    write('\x1b[?1049h\x1b[2J\x1b[H');
    const old = active;
    const [root, savedHost] = await Promise.all([
      workspaceDirectory(request.cwd).catch(() => null),
      loadHost().catch(() => null),
    ]);
    const transport = savedHost?.kind === 'https' ? new URL(savedHost.url).host : savedHost ? 'managed HTTPS host' : 'enter an HTTPS host on first use';
    const current = runtime ? 1 : 0;
    const selection = await choose(menu, root, current, transport);
    if (selection === 3 || selection === current || old.exited) return closeMenu();
    setup = new AbortController();
    const cancel = data => { if (data === '\x03' || data === '\x1b') setup.abort(new Error('Switch canceled.')); };
    menu.input = cancel;
    const report = text => { if (menu) write(`\r\n  ${text}\r\n`); };
    let next;
    try {
      if (selection === 2) {
        report('Press Esc to cancel sign-in.');
        const { signInClaude } = await import('./open-browser.mjs');
        const client = await signInClaude({ report, signal: setup.signal });
        await client.close();
        report(runtime ? 'Sign-in saved. Switch to Claude and back to Duet to refresh this connection.' : 'Sign-in saved. Choose Duet with workspace tools when you’re ready.');
        report('Press Enter to return to Claude Code.');
        await menuInput(menu, setup.signal, (data, done) => { if (data === '\r' || data === '\n') done(); });
        return closeMenu();
      }
      if (selection === 1) {
        if (!root) throw new Error('Claude Code’s current directory is unavailable for workspace tools.');
        const host = savedHost ?? await chooseHost(menu, setup.signal);
        write('\x1b[?25l');
        menu.input = cancel;
        next = await startRuntime({ root, host, report, signal: setup.signal, allowSignIn: true });
      } else report('Switching to Claude…');
      setup.signal.throwIfAborted();
      if (old.exited) throw new Error('Claude Code closed during the switch.');
      old.switching = true;
      old.pty.write('/exit\r');
      const exited = await Promise.race([old.exit.then(() => true), delay(6000, false, { ref: false })]);
      if (!exited) { old.switching = false; throw new Error('Claude Code is still busy. Finish the active turn and retry.'); }
      let transcript;
      if (typeof request.transcript === 'string') transcript = await stat(request.transcript).catch(() => null);
      const options = [...carriedOptions, transcript?.size ? '--resume' : '--session-id', request.session];
      await runtime?.stop();
      runtime = next;
      next = undefined;
      closeMenu(false);
      launch(options, request.cwd);
    } catch (error) {
      await next?.stop();
      if (finishing) return;
      report(error.message);
      if (!old.exited && menu) {
        report('Press Enter or Esc to return to Claude Code.');
        await new Promise(resolve => {
          menu.input = data => { if (['\r', '\n', '\x03', '\x1b'].includes(data)) resolve(); };
        });
      }
      closeMenu();
      if (old.exited) await finish(1);
    } finally { setup = undefined; }
  }

  let polling = false;
  const watcher = setInterval(async () => {
    if (polling || menu || finishing) return;
    polling = true;
    try {
      const request = await parseRequest();
      if (request) await switchRoute(request);
    } catch (error) { closeMenu(); write(`\r\n${error.message}\r\n`); }
    finally { polling = false; }
  }, 100);
  process.once('SIGTERM', () => { void finish(143); });
  process.once('SIGHUP', () => { void finish(129); });
  process.stdin.setRawMode(true);
  process.stdin.on('data', onInput);
  process.stdout.on('resize', onResize);
  try { launch(args, process.cwd()); }
  catch (error) { write(`${error.message}\r\n`); await finish(1); }
}

const passthrough = new Set(['-p', '--print', '-h', '--help', '-v', '--version', '--bare', '--safe-mode', '--bg', '--background', '--cloud', '--desktop']);
const nativeCommands = new Set(['agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'help', 'import', 'install', 'kill',
  'logs', 'mcp', 'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'ultrareview', 'update', 'upgrade']);
if (!process.stdin.isTTY || !process.stdout.isTTY || nativeCommands.has(args[0]) || args.some(arg => passthrough.has(arg.split('=')[0]))) await direct();
else await interactive();

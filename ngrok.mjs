import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyWorkspaceEndpoint } from './mcp-host.mjs';

function agentError(code) {
  if (code === 'ERR_NGROK_334') return new Error('The ngrok endpoint is already online. Close its other session before enabling this workspace.');
  if (['ERR_NGROK_105', 'ERR_NGROK_107', 'ERR_NGROK_108', 'ERR_NGROK_4018'].includes(code)) {
    return new Error(`ngrok could not use the configured account (${code}). Check ngrok's account credentials or active sessions.`);
  }
  return new Error(`ngrok exited before opening the endpoint${code ? ` (${code})` : ''}.`);
}

export async function startNgrok({ local, localToken, signal }) {
  signal.throwIfAborted();
  const args = ['http', local, '--log=stdout', '--log-format=json', '--inspect=false'];
  if (process.env.DUET_NGROK_URL) args.push(`--url=${process.env.DUET_NGROK_URL}`);
  const child = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  let close;
  const done = new Promise(resolve => {
    child.once('close', () => { exited = true; resolve(); });
  });
  const stop = () => close ??= (async () => {
    signal.removeEventListener('abort', abort);
    if (exited) return;
    child.kill('SIGTERM');
    const graceful = await Promise.race([done.then(() => true), delay(2500, false, { ref: false })]);
    if (!graceful && !exited) child.kill('SIGKILL');
    await done;
  })();
  const abort = () => { void stop(); };
  signal.addEventListener('abort', abort, { once: true });

  try {
    const publicUrl = await new Promise((resolve, reject) => {
      let code;
      const stdout = createInterface({ input: child.stdout });
      const stderr = createInterface({ input: child.stderr });
      const timeout = setTimeout(() => settle(new Error('ngrok did not open an HTTPS endpoint in time.')), 20_000);
      function settle(error, url) {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        child.removeListener('close', onClose);
        child.removeListener('error', onError);
        stdout.close();
        stderr.close();
        child.stdout.resume();
        child.stderr.resume();
        if (error) reject(error);
        else resolve(url);
      }
      function onLine(line) {
        code = line.match(/ERR_NGROK_\d+/)?.[0] ?? code;
        try {
          const record = JSON.parse(line);
          if (/^started (?:tunnel|endpoint)$/i.test(record.msg ?? '') && record.url) {
            const url = new URL(record.url);
            if (url.protocol === 'https:' && !url.username && !url.password) settle(null, url);
          }
        } catch {}
      }
      const onAbort = () => settle(signal.reason);
      const onClose = () => settle(agentError(code));
      const onError = error => settle(new Error(error.code === 'ENOENT' ? 'Install the ngrok CLI to enable workspace tools.' : `Could not start ngrok (${error.code ?? 'spawn failed'}).`));
      stdout.on('line', onLine);
      stderr.on('line', onLine);
      child.once('close', onClose);
      child.once('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const connectorUrl = new URL('/mcp', publicUrl).href;
    await verifyWorkspaceEndpoint(connectorUrl, localToken, signal);
    if (exited) throw new Error('ngrok stopped before the workspace connector was ready.');
    return { connectorUrl, connectorKey: localToken, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { createDuet, groupSavedDuetChannels } from './duet.mjs';
import { createWorkspaceServer, loadChecks } from './local-tools.mjs';
import { authDirectory, ClaudeSignInRequired, openClaude, readClaudeSession, registerWorkspace } from './duet-http.mjs';
import { verifyWorkspaceEndpoint } from './mcp-host.mjs';
import { createProxy } from './proxy.mjs';

export async function workspaceDirectory(cwd) {
  let path = process.env.DUET_WORKSPACE || cwd;
  if (path === '~' || path.startsWith('~/')) path = homedir() + path.slice(1);
  const root = await realpath(resolve(cwd, path));
  if (!(await stat(root)).isDirectory() || root === dirname(root)) {
    throw new Error('Choose a directory below the filesystem root for workspace tools.');
  }
  if (root === authDirectory || root.startsWith(`${authDirectory}${sep}`)) throw new Error('Choose a workspace outside the Duet sign-in directory.');
  return root;
}

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function closeListener(server) {
  if (!server?.listening) return;
  server.close();
  server.closeAllConnections();
}

export async function startRuntime({ root, host, allowSignIn = false, report = () => {}, signal = new AbortController().signal }) {
  const workspaceToken = randomBytes(32).toString('hex');
  const gatewayToken = randomBytes(32).toString('hex');
  if (!['ngrok', 'https'].includes(host?.kind)) throw new Error('Choose an MCP host with `claude-duet-menu --setup`.');
  const checks = await loadChecks(process.env.DUET_CHECKS_FILE);
  const stopped = new AbortController();
  const personal = await realpath(homedir());
  const hideDotfiles = root === personal || personal.startsWith(`${root}${sep}`);
  const local = createWorkspaceServer({ root, token: workspaceToken, write: true, checks,
    signal: stopped.signal, hideDotfiles });
  let transport, client, proxy, connector;
  const stop = async () => {
    if (stopped.signal.aborted) return;
    stopped.abort();
    closeListener(local);
    closeListener(proxy);
    try {
      await transport?.stop();
    } finally {
      try { await connector?.stop(); }
      catch { report(`Workspace tools are offline. The inactive connector ${connector.name} may still be listed in Claude.`); }
      await client?.close();
    }
  };
  try {
    report('Connecting to Duet…');
    try { client = await openClaude(await readClaudeSession(), signal); }
    catch (error) {
      if (!(error instanceof ClaudeSignInRequired) || !allowSignIn) throw error;
      const { signInClaude } = await import('./open-browser.mjs');
      client = await signInClaude({ report, signal });
    }
    signal.throwIfAborted();
    report(host.kind === 'https' ? `Checking the HTTPS host for ${basename(root)}…` : `Starting the saved HTTPS tunnel for ${basename(root)}…`);
    const lifetime = AbortSignal.any([signal, stopped.signal]);
    const localUrl = await listen(local, host.kind === 'https' ? host.port : 0);
    if (host.kind === 'https') {
      await verifyWorkspaceEndpoint(host.url, workspaceToken, lifetime);
      transport = { connectorUrl: host.url, connectorKey: workspaceToken, stop: async () => {} };
    } else {
      const { startNgrok } = await import('./ngrok.mjs');
      transport = await startNgrok({ local: localUrl, localToken: workspaceToken, signal: lifetime });
    }
    signal.throwIfAborted();
    report('Setting up Local Workspace…');
    connector = await registerWorkspace(client, transport.connectorUrl, transport.connectorKey, signal);
    signal.throwIfAborted();
    try { await groupSavedDuetChannels(client, signal); }
    catch {
      signal.throwIfAborted();
      report('Duet could not move saved chats into the Claude Code group.');
    }
    signal.throwIfAborted();

    const ask = createDuet({ client, shutdown: stopped.signal });
    const seeded = new Set();
    proxy = createProxy({ token: gatewayToken, carryConversation: true, askDuet: async (prompt, signal, id, history) => {
      if (seeded.has(id)) return ask(prompt, signal, id);
      const context = [`For requests about my local workspace, use the ${connector.name} connector's tools directly.`];
      if (history) context.push(`Recent context from this same terminal chat, for continuity only.\n${history}`);
      const first = `${context.join('\n\n')}\n\nNewest request\n${prompt}`;
      const answer = await ask(first, signal, id);
      seeded.add(id);
      return answer;
    } });
    const endpoint = await listen(proxy);
    return { endpoint, token: gatewayToken, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

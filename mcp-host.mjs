import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const configPath = () => resolve(process.env.DUET_HOST_CONFIG ?? fileURLToPath(new URL('.duet-host.json', import.meta.url)));
export const defaultMcpPort = 41331;

export function httpsHost(value, port = defaultMcpPort) {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      /^(localhost\.?|127\.|\[::1\])/i.test(url.hostname)) {
    throw new Error('Enter a public HTTPS URL on port 443, such as https://mcp.example.com/mcp.');
  }
  const localPort = Number(port);
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
    throw new Error('Enter a local port from 1024 to 65535.');
  }
  if (url.pathname === '/') url.pathname = '/mcp';
  return { kind: 'https', url: url.href, port: localPort };
}

function validate(config) {
  if (config?.kind === 'ngrok') return { kind: 'ngrok' };
  if (config?.kind === 'https') return httpsHost(config.url, config.port);
  throw new Error('Choose the MCP host again with `claude-duet-menu --setup`.');
}

export async function loadHost() {
  try { return validate(JSON.parse(await readFile(configPath(), 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('The MCP host settings are invalid. Run `claude-duet-menu --setup`.');
    throw error;
  }
}

export async function saveHost(config) {
  const normalized = validate(config);
  const path = configPath();
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(pending, JSON.stringify(normalized, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
  return normalized;
}

export async function setupHost() {
  if (!process.stdin.isTTY) throw new Error('Run setup in an interactive terminal.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async question => (await prompt.question(question)).trim();
  try {
    console.log('Local Workspace host\nUse your own public HTTPS endpoint on port 443.');
    let config;
    while (!config) {
      const url = await ask('Public MCP URL (Enter to skip) ');
      if (!url) return;
      try { config = httpsHost(url, (await ask(`Local forwarding port [${defaultMcpPort}] `)) || defaultMcpPort); }
      catch (error) { console.error(error.message); }
    }
    await saveHost(config);
    console.log(`Forward ${config.url} to http://127.0.0.1:${config.port}/mcp and preserve the x-api-key header.`);
    console.log('Saved. Choose Duet in /duet:proxy to connect.');
  } finally { prompt.close(); }
}

export async function verifyWorkspaceEndpoint(url, token, signal) {
  let last = 'unreachable';
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(4500)]);
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'workspace-check', method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Claude Duet bridge', version: '0.1.0' } } });
      const request = { method: 'POST', body, redirect: 'error', signal: attempt };
      const unauthenticated = await fetch(url, { ...request, headers });
      await unauthenticated.body?.cancel();
      last = `unauthenticated HTTP ${unauthenticated.status}`;
      if (unauthenticated.ok) throw new Error('The public MCP host accepted an unauthenticated workspace request.');
      if ([401, 403].includes(unauthenticated.status)) {
        const authenticated = await fetch(url, { ...request, headers: { ...headers, 'x-api-key': token } });
        last = `authenticated HTTP ${authenticated.status}`;
        if (authenticated.ok && authenticated.headers.get('content-type')?.includes('application/json')) {
          const result = await authenticated.json();
          if (result.result?.serverInfo?.name === 'Duet Local Workspace') return;
        } else await authenticated.body?.cancel();
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error.message.includes('accepted an unauthenticated')) throw error;
    }
    await delay(600, undefined, { signal });
  }
  throw new Error(`The public MCP host could not verify Local Workspace (${last}).`);
}

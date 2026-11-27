import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkspaceServer } from '../local-tools.mjs';
import { httpsHost, verifyWorkspaceEndpoint } from '../mcp-host.mjs';
import { createProxy } from '../proxy.mjs';
import { workspaceDirectory } from '../runtime.mjs';

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('workspace paths use the exact current directory', async t => {
  const override = process.env.DUET_WORKSPACE;
  delete process.env.DUET_WORKSPACE;
  t.after(() => { if (override !== undefined) process.env.DUET_WORKSPACE = override; });
  const root = await mkdtemp(join(tmpdir(), 'duet-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = join(root, 'nested');
  await mkdir(nested);
  await mkdir(join(root, '.git'));
  assert.equal(await workspaceDirectory(nested), await realpath(nested));
  assert.equal(await workspaceDirectory(homedir()), await realpath(homedir()));
});

test('workspace MCP keeps hidden paths private in home scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'duet-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'visible.txt'), 'workspace');
  await writeFile(join(root, '.private'), 'internal');
  const origin = await listen(createWorkspaceServer({ root, token: 'fixture', hideDotfiles: true, write: true }), t);
  const url = new URL('/mcp', origin);
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-api-key': 'wrong' } })).status, 401);
  await verifyWorkspaceEndpoint(url, 'fixture', AbortSignal.timeout(2000));
  const client = new Client({ name: 'fixture', version: '0.1.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-api-key': 'fixture' } } }));
  const call = (name, args) => client.callTool({ name, arguments: args });
  assert.equal((await call('read_file', { path: 'visible.txt' })).content[0].text, 'workspace');
  assert.equal((await call('read_file', { path: '.private' })).isError, true);
  assert.equal((await call('create_file', { path: '.hidden', text: 'internal' })).isError, true);
});

test('workspace MCP excludes saved Duet sign-in in project scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'duet-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.duet-auth'));
  await writeFile(join(root, '.duet-auth', 'session.json'), 'fixture sign-in data');
  const origin = await listen(createWorkspaceServer({ root, token: 'fixture', write: true }), t);
  const client = new Client({ name: 'fixture', version: '0.1.0' });
  t.after(() => client.close());
  const url = new URL('/mcp', origin);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-api-key': 'fixture' } } }));
  const call = (name, args) => client.callTool({ name, arguments: args });
  assert.doesNotMatch((await call('list_files', {})).content[0].text, /duet-auth/);
  assert.equal((await call('read_file', { path: '.duet-auth/session.json' })).isError, true);
  assert.equal((await call('create_file', { path: '.duet-auth/other.json', text: 'fixture' })).isError, true);
});

test('custom MCP hosts require HTTPS on port 443', () => {
  assert.deepEqual(httpsHost('https://mcp.example.com'), {kind: 'https', url: 'https://mcp.example.com/mcp', port: 41331});
  assert.throws(() => httpsHost('http://mcp.example.com'), /HTTPS/);
  assert.throws(() => httpsHost('https://mcp.example.com:8443/mcp'), /port 443/);
  assert.throws(() => httpsHost('https://mcp.example.com/mcp', 443), /local port/);
});

test('gateway forwards the current prompt and recent session text', async t => {
  const session = '01234567-0123-4567-89ab-0123456789ab';
  const server = createProxy({ token: 'fixture', carryConversation: true, askDuet: async (prompt, _signal, id, history) => {
    assert.equal(prompt, 'Latest question');
    assert.equal(id, session);
    assert.match(history, /Earlier question/);
    return 'Duet answer';
  } });
  const origin = await listen(server, t);
  const response = await fetch(`${origin}/v1/messages`, { method: 'POST', headers: {
    'x-api-key': 'fixture', 'x-claude-code-session-id': session, 'content-type': 'application/json',
  }, body: JSON.stringify({ model: 'fixture', messages: [
    { role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Latest question' },
  ] }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'Duet answer');
});

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { request } from 'playwright-core';

export const claudeOrigin = 'https://claude.ai';
export const authDirectory = fileURLToPath(new URL('.duet-auth', import.meta.url));
const authFile = fileURLToPath(new URL('.duet-auth/session.json', import.meta.url));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class ClaudeSignInRequired extends Error {
  constructor() {
    super('Claude needs sign-in or verification. Run `claude-duet-menu --login`, then retry.');
  }
}

class ClaudeHttpError extends Error {
  constructor(status, method, path) {
    const route = path.replace(/\/[0-9a-f-]{36}(?=\/|$)|\/chan_[A-Za-z0-9]+(?=\/|$)/gi, '/:id');
    super(`Claude returned HTTP ${status} for ${method} ${route}.`);
    this.status = status;
  }
}

async function privateSessionFile() {
  const directory = await lstat(authDirectory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!directory) return false;
  if (!directory.isDirectory() || directory.mode & 0o077) {
    throw new Error('The .duet-auth directory must be private (mode 700).');
  }
  const file = await lstat(authFile).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!file) return false;
  if (!file.isFile() || file.mode & 0o077) throw new Error('The Duet session file must be private (mode 600).');
  return true;
}

export async function readClaudeSession() {
  if (!await privateSessionFile()) return null;
  try { return JSON.parse(await readFile(authFile, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError || error.code === 'ENOENT') throw new ClaudeSignInRequired();
    throw error;
  }
}

export async function saveClaudeSession(api) {
  const { cookies } = await api.storageState();
  await mkdir(authDirectory, { mode: 0o700, recursive: true });
  await privateSessionFile();
  const temporary = `${authFile}.${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify({ cookies, origins: [] }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, authFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function openClaude(storageState, signal) {
  if (!storageState || !Array.isArray(storageState.cookies)) throw new ClaudeSignInRequired();
  const cookies = storageState.cookies.filter(cookie => cookie?.domain?.replace(/^\./, '') === 'claude.ai');
  if (!cookies.some(cookie => cookie.name === 'sessionKey')) throw new ClaudeSignInRequired();
  const api = await request.newContext({ storageState: { cookies, origins: [] }, maxRedirects: 0 });
  let organization;
  async function call(path, { method = 'GET', data, signal, allowMissing = false, discard = false } = {}) {
    signal?.throwIfAborted();
    const url = new URL(path, claudeOrigin);
    if (url.origin !== claudeOrigin || !/^\/(api|v1)\//.test(url.pathname)) throw new Error('Invalid Claude API route.');
    const headers = { accept: 'application/json', 'anthropic-version': '2023-06-01' };
    if (organization) headers['x-organization-uuid'] = organization;
    if (method !== 'GET') headers.origin = claudeOrigin;
    let response;
    try {
      response = await api.fetch(url.href, { method, data, headers, timeout: 12_000 });
    } catch {
      signal?.throwIfAborted();
      throw new Error('Could not reach Claude over HTTPS. Check your connection and retry.');
    }
    try {
      if (response.status() === 401 || response.headers()['cf-mitigated'] === 'challenge' ||
          (response.status() >= 300 && response.status() < 400)) throw new ClaudeSignInRequired();
      if (allowMissing && response.status() === 404) return null;
      if (!response.ok()) throw new ClaudeHttpError(response.status(), method, url.pathname);
      if (discard || response.status() === 204) return null;
      const body = await response.text();
      if (!body) return null;
      try { return JSON.parse(body); }
      catch { throw new Error('Claude returned an unexpected HTTPS response.'); }
    } finally {
      await response.dispose();
    }
  }

  try {
    const orgs = await call('/api/organizations', { signal });
    if (!Array.isArray(orgs)) throw new Error('Claude returned an unexpected organization list.');
    const chatOrgs = orgs.filter(org => uuid.test(org?.uuid ?? '') && org.capabilities?.includes('chat'));
    for (const org of chatOrgs) {
      organization = org.uuid;
      try {
        await call('/v1/code/aibo/project', { method: 'POST', data: { find_only: true }, signal });
        return { organization, call, storageState: () => api.storageState(), close: () => api.dispose() };
      } catch (error) {
        if (!(error instanceof ClaudeHttpError && [403, 404].includes(error.status))) throw error;
      }
    }
    throw new Error('This Claude sign-in has no organization with Duet channels.');
  } catch (error) {
    await api.dispose();
    throw error;
  }
}

export async function registerWorkspace(client, url, key, signal) {
  const path = `/api/organizations/${client.organization}/mcp/remote_servers`;
  const list = await client.call(`${path}_with_connection`, { signal });
  if (!Array.isArray(list)) throw new Error('Claude returned an unexpected connector list.');
  const names = new Set(list.map(item => item.name));
  let name = 'Local Workspace';
  for (let index = 2; names.has(name); index++) name = `Local Workspace ${index}`;
  await client.call(`/api/organizations/${client.organization}/mcp/probe`, { method: 'POST', data: { url }, signal, discard: true });
  const connector = await client.call(path, {
    method: 'POST', signal, data: {
      name, url,
      install: {
        type: 'custom',
        transport: 'streamable-http',
        posture: 'auth_required',
        auth_method: {
          type: 'static_headers',
          mcp_request_headers: [{ name: 'x-api-key', scope: 'organization', required: true }],
        },
        inputs: [{ type: 'mcp_request_header', name: 'x-api-key', value: key }],
      },
      attestations: [],
      add_product_surface: 'claude-web',
      add_plugins_unified_ui_served: true,
      form_variant: 'wizard',
      form_entry_point: 'settings_modal',
    },
  });
  if (!uuid.test(connector?.uuid ?? '') || connector.existing || connector.name !== name || connector.url !== url) {
    throw new Error('Claude did not confirm a new Local Workspace connector.');
  }
  const stop = () => client.call(`${path}/${connector.uuid}`, { method: 'DELETE', allowMissing: true });
  try {
    const auth = new URLSearchParams({
      redirect_url: `${claudeOrigin}/connector/${connector.uuid}/auth_done?_=1`,
      open_in_browser: '1',
      product_surface: 'claude-web',
      client_attempt_id: randomUUID(),
      user_confirmed: '1',
      plugins_unified_ui_served: '1',
      response_format: 'json',
    });
    await client.call(`/api/organizations/${client.organization}/mcp/start-auth/${connector.uuid}?${auth}`, { signal });
    const connected = await client.call(`${path}_with_connection`, { signal });
    if (!connected?.some(row => row.uuid === connector.uuid && row.connection_state === 'connected')) {
      throw new Error('Claude registered Local Workspace but could not connect to its tools.');
    }
    return { name, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

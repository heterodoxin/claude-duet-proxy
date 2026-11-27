import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';

const run = promisify(execFile);
const maxBytes = 128 * 1024;
const pathInput = z.string().min(1).max(1000);
const restricted = name => /^(\.git|\.ssh|\.gnupg|\.browser|\.duet-auth|\.proxy-token|\.tools-token|\.relay\.json|\.env(?:\..*)?|.*\.(?:pem|key|p12))$/i.test(name);

export async function loadChecks(path) {
  const checks = path ? JSON.parse(await readFile(path, 'utf8')) : {};
  if (!checks || Array.isArray(checks) || typeof checks !== 'object' || Object.entries(checks).some(([name, command]) =>
    !/^[\w-]+$/.test(name) || !Array.isArray(command) || !command.length || !command[0] || command.some(value => typeof value !== 'string'))) {
    throw new Error('DUET_CHECKS_FILE must map check names to executable argument arrays.');
  }
  return checks;
}

async function inside(root, relative = '.', excluded = restricted) {
  if (isAbsolute(relative)) throw new Error('Use a path relative to the configured workspace.');
  let path = root;
  for (const segment of relative.split(sep)) {
    if (!segment || segment === '.') continue;
    if (segment === '..' || excluded(segment)) throw new Error('That path is outside the permitted workspace files.');
    path = join(path, segment);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Symbolic links are unavailable in this workspace connector.');
  }
  if (await realpath(path) !== path) throw new Error('That path no longer resolves inside the workspace.');
  return path;
}

async function readText(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('Choose a regular text file up to 128 KiB.');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error('Choose a text file up to 128 KiB.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    if (text.includes('\0')) throw new Error('Choose a UTF-8 text file.');
    return { text, info };
  } finally {
    await file.close();
  }
}

const result = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError && { isError }) });

export function createWorkspaceServer({ root, token, write = false, checks = {}, signal, hideDotfiles = false }) {
  const expected = Buffer.from(token);
  const excluded = name => restricted(name) || (hideDotfiles && name.startsWith('.'));
  const workspacePath = path => inside(root, path, excluded);
  let writing = false;
  const handle = (action) => async args => {
    try {
      signal?.throwIfAborted();
      return result(await action(args));
    }
    catch (error) {
      const message = error.code ? `Workspace operation failed (${error.code}).` : error.message;
      return result(message, true);
    }
  };

  function build() {
    const mcp = new McpServer({ name: 'Duet Local Workspace', version: '0.1.0' });
    mcp.registerTool('list_files', {
      description: 'List the immediate files and directories in the local workspace. Paths are workspace-relative.',
      inputSchema: { path: pathInput.optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
    }, handle(async ({ path }) => {
      const entries = (await readdir(await workspacePath(path), { withFileTypes: true }))
        .filter(entry => !excluded(entry.name) && (entry.isFile() || entry.isDirectory()))
        .map(entry => entry.name + (entry.isDirectory() ? '/' : '')).sort();
      return entries.slice(0, 400).join('\n') + (entries.length > 400 ? '\n[Listing truncated]' : '');
    }));
    mcp.registerTool('read_file', {
      description: 'Read a local UTF-8 text file from the configured workspace. Use a workspace-relative path.',
      inputSchema: { path: pathInput }, annotations: { readOnlyHint: true, openWorldHint: false },
    }, handle(async ({ path }) => (await readText(await workspacePath(path))).text));

    mcp.registerTool('search_text', {
      description: 'Find literal text in the local workspace. Returns matching paths and line numbers. The optional path is workspace-relative.',
      inputSchema: { text: z.string().min(1).max(200).refine(text => !text.includes('\n')), path: pathInput.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, handle(async ({ text, path }) => {
      const target = await workspacePath(path);
      const relative = target === root ? '.' : target.slice(root.length + 1);
      const args = ['--no-config', '--no-follow', '--fixed-strings', '--line-number', '--with-filename', '--no-heading',
        '--color=never', '--max-count=12', '--max-filesize=128K', '--glob=!.duet-auth', '--glob=!*.pem', '--glob=!*.key', '--glob=!*.p12', '--', text, relative];
      try {
        const { stdout } = await run('rg', args, { cwd: root, timeout: 7_000, maxBuffer: maxBytes, signal });
        const lines = stdout.trimEnd().split('\n');
        return lines.slice(0, 100).join('\n') + (lines.length > 100 ? '\n[Results truncated]' : '');
      } catch (error) {
        if (error.code === 1) return 'No matches.';
        throw error;
      }
    }));

    if (write) mcp.registerTool('replace_text', {
      description: 'Replace one exact, unique text match in an existing local workspace file. Read the file first.',
      inputSchema: { path: pathInput, old_text: z.string().min(1).max(maxBytes), new_text: z.string().max(maxBytes) },
      annotations: { destructiveHint: true, openWorldHint: false },
    }, handle(async ({ path, old_text, new_text }) => {
      if (writing) throw new Error('A workspace edit is already in progress.');
      writing = true;
      let temporary;
      try {
        const target = await workspacePath(path);
        const { text, info } = await readText(target);
        const start = text.indexOf(old_text);
        if (start < 0 || text.indexOf(old_text, start + 1) >= 0) throw new Error('The original text must occur exactly once.');
        const next = text.slice(0, start) + new_text + text.slice(start + old_text.length);
        if (Buffer.byteLength(next) > maxBytes) throw new Error('Edited file would exceed 128 KiB.');
        temporary = join(dirname(target), `.duet-${randomBytes(12).toString('hex')}`);
        await writeFile(temporary, next, { flag: 'wx', mode: info.mode & 0o777 });
        const current = await readText(await workspacePath(path));
        if (current.text !== text || current.info.ino !== info.ino || current.info.mtimeMs !== info.mtimeMs) {
          throw new Error('The file changed during the edit. Read it and retry.');
        }
        await rename(temporary, target);
        temporary = undefined;
        return `Updated ${path}.`;
      } finally {
        try { if (temporary) await rm(temporary, { force: true }); }
        finally { writing = false; }
      }
    }));

    if (write) mcp.registerTool('create_file', {
      description: 'Create a new UTF-8 text file in an existing local workspace directory. Existing files are never overwritten.',
      inputSchema: { path: pathInput, text: z.string().max(maxBytes) },
      annotations: { destructiveHint: false, openWorldHint: false },
    }, handle(async ({ path, text }) => {
      const filename = basename(path);
      if (isAbsolute(path) || !filename || ['.', '..'].includes(filename) || excluded(filename) || path.endsWith(sep)) {
        throw new Error('Choose a workspace-relative path to a new file.');
      }
      if (Buffer.byteLength(text) > maxBytes) throw new Error('New file would exceed 128 KiB.');
      const directory = await workspacePath(dirname(path));
      await writeFile(join(directory, filename), text, { flag: 'wx', mode: 0o644 });
      return `Created ${path}.`;
    }));

    const names = Object.keys(checks);
    if (names.length) mcp.registerTool('run_check', {
      description: `Run a preconfigured local check in the workspace. Available checks: ${names.join(', ')}.`,
      inputSchema: { name: z.enum(names) }, annotations: { openWorldHint: true },
    }, handle(async ({ name }) => {
      const [file, ...args] = checks[name];
      try {
        const { stdout, stderr } = await run(file, args, { cwd: root, timeout: 45_000, maxBuffer: maxBytes, signal });
        return `Exit 0\n${stdout}${stderr}`;
      } catch (error) {
        if (error.stdout !== undefined) return `Check failed (${error.code ?? error.signal ?? 'timeout'})\n${error.stdout}${error.stderr}`;
        throw error;
      }
    }));
    return mcp;
  }

  return createServer(async (request, response) => {
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    const actual = Buffer.from(request.headers['x-api-key'] ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.writeHead(401).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return; }
    const mcp = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once('close', () => { void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
      else if (!response.writableEnded) response.end();
    }
  });
}

async function start() {
  const args = process.argv.slice(2);
  if (!args[0] || args.slice(1).some(argument => argument !== '--write')) {
    throw new Error('Usage: node local-tools.mjs /path/to/workspace [--write]');
  }
  const root = await realpath(resolve(args[0]));
  if (!(await lstat(root)).isDirectory() || root === '/' || root === await realpath(process.env.HOME)) {
    throw new Error('Choose a specific project directory.');
  }
  const checks = await loadChecks(process.env.DUET_CHECKS_FILE);
  const tokenPath = new URL('.tools-token', import.meta.url);
  try { await writeFile(tokenPath, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('The workspace connector token file is invalid.');
  const port = Number(process.env.DUET_TOOLS_PORT ?? 41331);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DUET_TOOLS_PORT.');
  createWorkspaceServer({ root, token, checks, write: args.includes('--write') }).listen(port, '127.0.0.1', () => {
    console.log(`Workspace connector for ${basename(root)} listening on http://127.0.0.1:${port}/mcp`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await start();

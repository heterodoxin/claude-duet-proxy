import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { claudeOrigin, ClaudeSignInRequired, openClaude, saveClaudeSession } from './duet-http.mjs';

const duetUrl = `${claudeOrigin}/duet`;
const profile = resolve(process.env.DUET_BROWSER_PROFILE ?? fileURLToPath(new URL('.browser/', import.meta.url)));

export function findChromium() {
  if (process.env.DUET_CHROME) return existsSync(process.env.DUET_CHROME) ? process.env.DUET_CHROME : undefined;
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
  const cached = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium-\d+$/.test(name))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map(name => join(cache, name, 'chrome-linux64', 'chrome')) : [];
  return [chromium.executablePath(), ...cached, '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
}

async function browserVersion(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
  return response?.ok ? response.json().catch(() => null) : null;
}

function browserPort() {
  const port = Number(process.env.DUET_BROWSER_PORT ?? 41327);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DUET_BROWSER_PORT.');
  return port;
}

async function managedSession(browser, pid) {
  if (!pid) {
    try { pid = Number(readlinkSync(join(profile, 'SingletonLock')).match(/-(\d+)$/)?.[1]); }
    catch { throw new Error('Close the open Duet browser window and try again.'); }
  }
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  if (!processInfo.some(process => process.type === 'browser' && process.id === pid)) {
    throw new Error('The debug port belongs to another Chromium instance. Close it or use a different DUET_BROWSER_PORT.');
  }
  return session;
}

function launchBrowser(port, target) {
  const executable = findChromium();
  if (!executable) throw new Error('Install Chromium with npm run setup, or set DUET_CHROME to its executable.');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);
  return spawn(executable, [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', target,
  ], { stdio: 'ignore' });
}

async function waitForBrowser(port, child, signal) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    signal.throwIfAborted();
    if (await browserVersion(port)) return;
    await delay(250, undefined, { signal });
  }
  throw new Error('Could not open the Duet sign-in window. Close any existing Duet browser window and retry.');
}

export async function signInClaude({ report, signal }) {
  const port = browserPort();
  let browser, child, session;
  try {
    signal.throwIfAborted();
    if (!await browserVersion(port)) {
      report('Opening Duet sign-in…');
      child = launchBrowser(port, 'about:blank');
      await once(child, 'spawn');
      await waitForBrowser(port, child, signal);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
    session = await managedSession(browser, child?.pid);
    const context = browser.contexts()[0];
    signal.throwIfAborted();
    const existing = context.pages().find(page => page.url().startsWith(duetUrl));
    const page = existing ?? (child && context.pages()[0]) ?? await context.newPage();
    if (!existing) await page.goto(duetUrl, { waitUntil: 'commit', timeout: 20_000 });
    await page.bringToFront();
    report('Sign in with the Claude account that has Duet access. The launcher will continue automatically.');
    for (;;) {
      signal.throwIfAborted();
      if (!browser.isConnected() || page.isClosed()) throw new Error('The Duet sign-in window was closed. Open sign-in again to retry.');
      let client;
      try {
        client = await openClaude({ cookies: await context.cookies(claudeOrigin) }, signal);
        signal.throwIfAborted();
        await saveClaudeSession(client);
        return client;
      } catch (error) {
        await client?.close();
        if (!(error instanceof ClaudeSignInRequired)) throw error;
      }
      await delay(2500, undefined, { signal });
    }
  } finally {
    if (child) {
      if (session && browser?.isConnected()) await session.send('Browser.close').catch(() => {});
      else if (child.pid && child.exitCode === null) child.kill();
    }
    await browser?.close().catch(() => {});
  }
}

export async function openDuetBrowser() {
  const port = browserPort();
  let target = duetUrl;
  const existing = await browserVersion(port);
  if (existing) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
    try {
      const session = await managedSession(browser);
      const context = browser.contexts()[0];
      const tabs = context.pages().filter(tab => /^https:\/\/claude\.ai\/(?:duet|messages)\/chan_[a-z0-9]+\/?$/i.test(tab.url()));
      const page = tabs.at(-1) ?? context.pages().find(tab => tab.url().startsWith(duetUrl));
      if (!existing['User-Agent']?.includes('HeadlessChrome')) {
        if (page) await page.bringToFront();
        else await (await context.newPage()).goto(duetUrl, { waitUntil: 'domcontentloaded' });
        return;
      }
      target = page?.url() ?? duetUrl;
      await session.send('Browser.close').catch(error => { if (browser.isConnected()) throw error; });
    } finally { await browser.close().catch(() => {}); }
    const deadline = Date.now() + 10_000;
    while (await browserVersion(port)) {
      if (Date.now() >= deadline) throw new Error('Chromium is still closing. Retry opening the Duet browser.');
      await delay(250);
    }
  }

  const chromiumProcess = launchBrowser(port, target);
  chromiumProcess.on('error', error => { console.error(error.message); process.exitCode = 1; });
  chromiumProcess.on('exit', code => { process.exitCode = code ?? 0; });
}

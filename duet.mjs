import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { claudeOrigin } from './duet-http.mjs';

const channelId = /^chan_[A-Za-z0-9]+$/;
const sessionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const defaultChatFile = fileURLToPath(new URL('.duet-chats.json', import.meta.url));
const groupPath = '/v1/code/channel-groups';
const groupName = 'Claude Code';

function privateOwner(record, channel) {
  return record?.id === channel && record.visibility === 'private' && record.membership?.role === 'owner' &&
    !record.archived_at && !record.disabled_at && !record.members_truncated &&
    Array.isArray(record.members) && !record.members.length && Array.isArray(record.guests) && !record.guests.length &&
    record.membership.account_id && record.agent_id;
}

export function createDuet({ client, timeout = 150_000, chatFile = defaultChatFile, shutdown } = {}) {
  return async function askDuet(prompt, signal, sessionId) {
    if (shutdown) signal = AbortSignal.any([signal, shutdown]);
    signal.throwIfAborted();
    if (!sessionPattern.test(sessionId ?? '')) throw new Error('Invalid Claude Code session ID.');
    const chatDirectory = `${chatFile}.d`;
    const sessionFile = join(chatDirectory, sessionId);
    const previousChannel = await readChannel(sessionFile, chatFile, sessionId);
    let channel = previousChannel;
    if (!channel) {
      const name = `terminal-${sessionId.replaceAll('-', '').slice(0, 12)}`;
      const result = await client.call('/v1/code/aibo/rooms', {
        method: 'POST', data: { name, client_request_id: sessionId }, signal,
      });
      channel = result?.channel?.id;
      if (!channelId.test(channel ?? '') || !privateOwner(result.channel, channel)) {
        throw new Error('Duet could not create an active private channel you own.');
      }
    }

    const path = `/v1/code/channels/${channel}`;
    const metadata = await client.call(path, { signal, allowMissing: true });
    const record = metadata?.channel;
    if (!privateOwner(record, channel)) throw new Error('Duet could not verify an active private channel you own.');
    let groupingWarning = '';
    if (!previousChannel) {
      await mkdir(chatDirectory, { mode: 0o700, recursive: true });
      try { await writeFile(sessionFile, `${channel}\n`, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await readChannel(sessionFile, chatFile, sessionId) !== channel) {
          throw new Error('This Claude Code session is open in another Duet window.');
        }
      }
      try {
        await fileChannels(client, await readClaudeCodeGroup(client, signal), [channel], signal);
      } catch {
        signal.throwIfAborted();
        groupingWarning = '\n\nDuet could not move this chat into the Claude Code group. The launcher will retry the next time you enable Duet.';
      }
    }

    const timeline = await readTimeline(client, path, signal);
    if (timeline.some(message => message.thread_any_session_working)) {
      throw new Error('Duet is already working in this channel. Wait for it to finish.');
    }
    const baseline = new Set(timeline.map(message => message.id));
    const sent = await client.call(`${path}/messages`, {
      method: 'POST', signal,
      data: { body: prompt, client_message_id: randomUUID(), shown_text: { whole: true } },
    });
    if (typeof sent?.message_id !== 'string') throw new Error('Duet did not confirm the message.');

    const deadline = Date.now() + timeout;
    let previous = null;
    let unchangedSince = 0;
    while (Date.now() < deadline) {
      await delay(1_500, undefined, { signal });
      const current = await readTimeline(client, path, signal);
      const unseen = current.filter(message => !baseline.has(message.id));
      if (unseen.some(message => message.author_account_id === record.membership.account_id && message.id !== sent.message_id)) {
        throw new Error('Another message was sent in the Duet channel during this request.');
      }
      const ownMessage = unseen.find(message => message.id === sent.message_id);
      if (!ownMessage) continue;
      const replies = unseen.filter(message => message.author_agent_id === record.agent_id &&
        typeof message.created_at === 'string' && message.created_at > ownMessage.created_at);
      replies.sort((left, right) => left.created_at.localeCompare(right.created_at));
      const texts = replies.map(message => typeof message.body === 'string' ? message.body.trim() : '').filter(Boolean);
      const link = `[Open Duet channel](${claudeOrigin}/duet/${channel})`;
      if (replies.some(message => message.open_decisions?.length)) texts.push(`Duet has an approval waiting. ${link}`);
      if (replies.some(message => message.has_attachments || message.attached_outputs?.length)) {
        texts.push(`Duet attached an output. ${link}`);
      }
      const reply = texts.join('\n\n');
      const working = [ownMessage, ...replies].some(message => message.thread_any_session_working);
      if (reply !== previous || working) {
        previous = reply;
        unchangedSince = Date.now();
      }
      if (!working && reply && Date.now() - unchangedSince >= 3_000) return reply + groupingWarning;
    }
    if (previous) return previous + groupingWarning;
    throw new Error('Duet did not reply in time. Check the browser for a task or an approval.');
  };
}

function claudeCodeGroup(state) {
  if (!state || state.truncated || (state.data !== undefined && !Array.isArray(state.data))) {
    throw new Error('Duet returned an incomplete channel group list.');
  }
  return state.data?.find(group => typeof group?.name === 'string' && group.name.trim().toLowerCase() === groupName.toLowerCase());
}

function readClaudeCodeGroup(client, signal) {
  return client.call(groupPath, { signal }).then(claudeCodeGroup);
}

async function fileChannels(client, group, channels, signal) {
  const filed = new Set(group?.channel_ids);
  const pending = channels.filter(id => !filed.has(id));
  for (let offset = 0; offset < pending.length; offset += 200) {
    const batch = pending.slice(offset, offset + 200);
    const changes = group
      ? batch.map(channel => ({ type: 'add_channel', group_id: group.id, channel_id: channel }))
      : [{ type: 'create', id: randomUUID(), name: groupName, channel_ids: batch }];
    const result = await client.call(groupPath, { method: 'PATCH', data: { changes }, signal });
    group = claudeCodeGroup(result);
    const members = new Set(group?.channel_ids);
    if (batch.some(id => !members.has(id))) throw new Error('Duet could not confirm the Claude Code channel assignments.');
  }
}

export async function groupSavedDuetChannels(client, signal, chatFile = defaultChatFile) {
  const directory = `${chatFile}.d`;
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const sessions = entries.filter(entry => entry.isFile() && sessionPattern.test(entry.name));
  const legacy = await readFile(chatFile, 'utf8').then(JSON.parse).catch(error => {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return {};
  });
  const saved = await Promise.all(sessions.map(entry => readFile(join(directory, entry.name), 'utf8').then(text => text.trim())
    .catch(error => { if (error.code !== 'ENOENT') throw error; })));
  const legacyChannels = Object.entries(legacy ?? {}).filter(([id]) => sessionPattern.test(id)).map(([, channel]) => channel);
  const channels = new Set([...saved, ...legacyChannels].filter(id => typeof id === 'string' && channelId.test(id)));
  if (!channels.size) return;

  const group = await readClaudeCodeGroup(client, signal);
  const filed = new Set(group?.channel_ids);
  const pending = [...channels].filter(id => !filed.has(id));
  const owned = [];
  for (let offset = 0; offset < pending.length; offset += 8) {
    const batch = await Promise.all(pending.slice(offset, offset + 8).map(async id => {
      const result = await client.call(`/v1/code/channels/${id}`, { signal, allowMissing: true }).catch(error => {
        if (error.status !== 403) throw error;
        return null;
      });
      return privateOwner(result?.channel, id) ? id : null;
    }));
    owned.push(...batch.filter(Boolean));
  }
  await fileChannels(client, group, owned, signal);
}

async function readChannel(file, legacy, sessionId) {
  let data;
  try { data = (await readFile(file, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { data = JSON.parse(await readFile(legacy, 'utf8'))?.[sessionId]; }
    catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
  }
  if (data !== undefined && (typeof data !== 'string' || !/^chan_[A-Za-z0-9]+$/.test(data))) {
    throw new Error('The stored Duet chat mapping is invalid.');
  }
  return data;
}

async function readTimeline(client, path, signal) {
  const result = await client.call(`${path}/timeline?limit=32`, { signal });
  if (!Array.isArray(result?.data)) throw new Error('Unexpected Duet timeline format.');
  return result.data.filter(message => message.in_timeline !== false && !message.server_notice);
}

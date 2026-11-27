import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const maxBody = 2 * 1024 * 1024;
const maxPrompt = 200_000;

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function sendJSON(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readJSON(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= maxBody) chunks.push(chunk);
  }
  if (size > maxBody) throw new RequestError('Request exceeds 2 MiB.', 413);
  try {
    const data = JSON.parse(Buffer.concat(chunks));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  throw new RequestError('Expected a JSON object.');
}

function visibleText(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return (blocks ?? []).filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(Boolean).join('\n\n');
}

function latestPrompt(body) {
  if (!Array.isArray(body.messages)) throw new RequestError('Expected a message history.');
  const latest = body.messages.findLast(message => message?.role === 'user');
  if (!latest) throw new RequestError('Expected a user message.');
  if (typeof latest.content !== 'string' && (!Array.isArray(latest.content) ||
    latest.content.some(block => block?.type !== 'text' || typeof block.text !== 'string'))) {
    throw new RequestError('This Duet bridge accepts text messages.');
  }
  const prompt = visibleText(latest.content);
  if (!prompt) throw new RequestError('Expected a nonempty user message.');
  return prompt;
}

function previousConversation(messages) {
  const latest = messages.findLastIndex(message => message?.role === 'user');
  const text = messages.slice(0, latest).filter(message => ['user', 'assistant'].includes(message?.role))
    .slice(-30).map(message => ({ role: message.role, text: visibleText(message.content) }))
    .filter(message => message.text && !/^\/duet(?::proxy)?\s*$/i.test(message.text));
  let remaining = 18_000;
  const recent = [];
  for (const message of text.reverse()) {
    const label = `${message.role === 'user' ? 'User' : 'Claude'}: `;
    if (remaining < label.length + 20) break;
    const part = message.text.length > remaining - label.length ? `…${message.text.slice(-(remaining - label.length - 1))}` : message.text;
    recent.unshift(label + part);
    remaining -= label.length + part.length + 2;
  }
  return recent.join('\n\n');
}

function estimateTokens(data) {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(data)) / 4));
}

function emit(response, type, data = {}) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function sendStream(response, message) {
  emit(response, 'message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  emit(response, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: message.content[0].text } });
  emit(response, 'content_block_stop', { index: 0 });
  emit(response, 'message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  emit(response, 'message_stop');
  response.end();
}

export function createProxy({ askDuet, token, carryConversation = false }) {
  const expected = Buffer.from(token);
  let busy = false;
  return createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && path === '/health') return sendJSON(response, 200, { ok: true, busy });
    const supplied = Buffer.from(String(request.headers['x-api-key'] ?? request.headers.authorization?.replace(/^Bearer /i, '') ?? ''));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return sendJSON(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'Use the local bridge token.' } });
    }

    const controller = new AbortController();
    response.once('close', () => controller.abort());
    let heartbeat;
    let ownsChannel = false;
    try {
      if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(path)) {
        throw new RequestError('This bridge only serves Messages and Count Tokens.', 404);
      }
      const body = await readJSON(request);
      const prompt = latestPrompt(body);
      const inputTokens = estimateTokens(prompt);
      if (path.endsWith('/count_tokens')) return sendJSON(response, 200, { input_tokens: inputTokens });
      const sessionId = request.headers['x-claude-code-session-id'];
      if (typeof sessionId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId)) {
        throw new RequestError('The request is missing its Claude Code session ID.');
      }
      if (prompt.length > maxPrompt) throw new RequestError('Conversation exceeds the bridge’s 200,000-character prompt limit.', 413);
      if (busy) throw new RequestError('Duet is already serving a request from this bridge.');
      controller.signal.throwIfAborted();
      busy = ownsChannel = true;
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        response.flushHeaders();
        heartbeat = setInterval(() => emit(response, 'ping'), 5_000);
      }
      const history = carryConversation ? previousConversation(body.messages) : '';
      const text = await askDuet(prompt, controller.signal, sessionId.toLowerCase(), history);
      const content = [{ type: 'text', text }];
      const message = {
        id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', content,
        model: body.model ?? 'duet', stop_reason: 'end_turn',
        stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: estimateTokens(content) },
      };
      if (response.destroyed) return;
      if (body.stream) sendStream(response, message);
      else sendJSON(response, 200, message);
    } catch (error) {
      if (response.destroyed) return;
      const status = error.status ?? 400;
      const type = status === 404 ? 'not_found_error' : status === 413 ? 'request_too_large' : 'invalid_request_error';
      const apiError = { error: { type, message: String(error.message).split('\n')[0] } };
      if (response.headersSent) {
        emit(response, 'error', apiError);
        response.end();
      } else sendJSON(response, status, { type: 'error', ...apiError });
    } finally {
      clearInterval(heartbeat);
      if (ownsChannel) busy = false;
    }
  });
}

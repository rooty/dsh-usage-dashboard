import { readFileSync } from 'node:fs';
import { createMetricTools } from './metrics.js';
import { createReader } from './reader.js';

export const inject = ['connection', 'sessionQuery'];
const catalog = JSON.parse(readFileSync(new URL('./pricing.json', import.meta.url), 'utf8'));
const pricing = Object.freeze({ source: 'pi-ai-catalog', dshVersion: '0.2.2-rc.1', catalogVersion: '1.3.0', currency: 'USD', estimateOnly: true });
const PREFIX = '/api/local-usage-dashboard/';
const MAX_BODY = 4096;
const STATUSES = Object.freeze({ BAD_REQUEST: 400, INVALID_QUERY: 400, FORBIDDEN: 403, TOO_LARGE: 413, BAD_CONTENT_TYPE: 415, STALE_CURSOR: 409, ABORTED: 499, SOURCE_UNAVAILABLE: 503, UNAVAILABLE: 503, INTERNAL: 500 });
class SafeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new SafeError(code); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function exact(value, keys) { if (!isObject(value) || Object.keys(value).some(key => !keys.includes(key))) fail('BAD_REQUEST'); }
function id(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\x00-\x1f\x7f/\\]/.test(value) || value === '.' || value === '..') fail('BAD_REQUEST');
  return value;
}
function zone(value) {
  if (value === undefined) return 'UTC';
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) fail('INVALID_QUERY');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(0); } catch { fail('INVALID_QUERY'); }
  return value;
}
function validate(action, value) {
  if (action === 'session') {
    exact(value, ['sessionId', 'timeZone']);
    return { sessionId: id(value.sessionId), timeZone: zone(value.timeZone) };
  }
  exact(value, ['cursor', 'fromMs', 'toMs', 'timeZone', 'pinSessionId']);
  const result = { timeZone: zone(value.timeZone) };
  if (value.cursor !== undefined) {
    if (typeof value.cursor !== 'string' || value.cursor.length === 0 || value.cursor.length > 2048) fail('INVALID_QUERY');
    result.cursor = value.cursor;
  }
  for (const key of ['fromMs', 'toMs']) {
    if (value[key] === undefined || value[key] === null) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 8_640_000_000_000_000) fail('INVALID_QUERY');
    result[key] = value[key];
  }
  if (result.fromMs !== undefined && result.toMs !== undefined && result.fromMs >= result.toMs) fail('INVALID_QUERY');
  if (value.pinSessionId !== undefined) result.pinSessionId = id(value.pinSessionId);
  return result;
}
/** Connection's shared /api carrier authenticates an OWNER before this handler.
 * Missing Origin is legitimate only because Desktop's existing bridge strips it.
 * This handler is never registered on an independent listener or public Gateway.
 */
async function readRequest(request) {
  if (request.method !== 'POST') fail('BAD_REQUEST');
  if (request.headers.get('x-dsh-usage') !== '1' || request.headers.get('sec-fetch-site') === 'cross-site') fail('FORBIDDEN');
  const origin = request.headers.get('origin'), host = request.headers.get('host');
  if (origin !== null) {
    try {
      const source = new URL(origin);
      if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin || !host || new URL(`${source.protocol}//${host}`).host !== source.host) fail('FORBIDDEN');
    } catch { fail('FORBIDDEN'); }
  }
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') fail('BAD_CONTENT_TYPE');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) fail('TOO_LARGE');
  if (!request.body) fail('BAD_REQUEST');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      if (request.signal.aborted) fail('ABORTED');
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); fail('TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('BAD_REQUEST'); }
}
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
export function createHost(ctx, options = {}) {
  const reader = options.reader ?? createReader(ctx, createMetricTools(catalog));
  const unregister = []; let disposed = false;
  async function handle(action, request) {
    try {
      if (disposed) fail('UNAVAILABLE');
      const input = validate(action, await readRequest(request));
      if (request.signal.aborted) fail('ABORTED');
      const value = await reader[action](input, request.signal);
      if (disposed) fail('UNAVAILABLE');
      if (request.signal.aborted) fail('ABORTED');
      // Reader constructs a whitelist DTO; no events/headers enter this envelope.
      return json({ ok: true, schemaVersion: 1, generatedAtMs: Date.now(), pricing, [action === 'session' ? 'session' : 'page']: value });
    } catch (error) {
      const code = Object.hasOwn(STATUSES, error?.code) ? error.code : 'INTERNAL';
      return json({ ok: false, error: { code } }, STATUSES[code]);
    }
  }
  return {
    register() {
      for (const action of ['session', 'query']) {
        const off = ctx.connection.fetch.register({ path: PREFIX + action, methods: ['POST'], requestBody: 'buffered', fetch: request => handle(action, request) });
        if (typeof off === 'function') unregister.push(off);
      }
    },
    dispose() {
      if (disposed) return; disposed = true; reader.dispose();
      for (const off of unregister.splice(0)) { try { off(); } catch { /* native fiber also owns route disposal */ } }
    },
  };
}
export function apply(ctx) {
  const host = createHost(ctx); host.register();
  ctx.effect(() => () => host.dispose());
}

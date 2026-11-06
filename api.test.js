import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from './index.js';
import { createMetricTools } from './metrics.js';

function fixture(behavior = {}) {
  const routes = new Map(), calls = [];
  const reader = {
    async session(value, signal) { calls.push(['session', value, signal]); return behavior.session ? behavior.session(value, signal) : { sessionId: value.sessionId, metrics: createMetricTools().emptyMetrics(), models: [], days: [] }; },
    async query(value, signal) { calls.push(['query', value, signal]); return behavior.query ? behavior.query(value, signal) : { rows: [], nextCursor: null, totalSessions: 0, scannedSessions: 0, skippedSessions: 0, complete: true, timeZone: 'UTC', fromMs: null, toMs: null }; },
    dispose() { calls.push(['dispose']); },
  };
  const host = createHost({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } } }, { reader });
  host.register();
  function request(action = 'session', body = { sessionId: 'session-1' }, headers = {}, signal) {
    const h = new Headers({ host: '127.0.0.1:59907', origin: 'http://127.0.0.1:59907', 'content-type': 'application/json', 'x-dsh-usage': '1' });
    for (const [key, value] of Object.entries(headers)) { if (value === null) h.delete(key); else h.set(key, value); }
    return new Request(`http://dsh.internal/api/local-usage-dashboard/${action}`, { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body), signal });
  }
  async function call(action, body, headers, signal) {
    const response = await routes.get('/api/local-usage-dashboard/' + action).fetch(request(action, body, headers, signal));
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  return { routes, calls, host, request, call };
}

test('registers only two exact buffered POST routes on existing owner carrier; activation reads no sessions', () => {
  const f = fixture(); assert.equal(f.routes.size, 2); assert.equal(f.calls.length, 0);
  for (const route of f.routes.values()) { assert.deepEqual(route.methods, ['POST']); assert.equal(route.requestBody, 'buffered'); }
  f.host.dispose();
});

test('Web and Desktop shaped requests return only own dashboard envelope and non-stored responses', async () => {
  const f = fixture();
  for (const origin of [null, 'http://127.0.0.1:59907']) {
    const result = await f.call('session', { sessionId: 'session-1', timeZone: 'Europe/Warsaw' }, { origin });
    assert.equal(result.status, 200); assert.equal(result.data.ok, true); assert.equal(result.data.schemaVersion, 1);
    assert.equal(result.data.session.sessionId, 'session-1'); assert.equal(result.data.pricing.estimateOnly, true); assert.equal(result.data.pricing.currency, 'USD');
    assert.equal(result.data.pricing.models, undefined); assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal(f.calls.length, 2); f.host.dispose();
});

test('rejects missing non-simple header, foreign/null/empty Origin and cross-site before business reads', async () => {
  const f = fixture();
  for (const headers of [{ 'x-dsh-usage': null }, { 'x-dsh-usage': '0' }, { origin: 'https://evil.example' }, { origin: 'null' }, { origin: '' }, { origin: 'http://127.0.0.1:59908' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.call('session', { sessionId: 'session-1' }, headers)).status, 403);
  }
  assert.equal(f.calls.length, 0); f.host.dispose();
});

test('bounds body and validates exact parameters, session ids and date/timezone before native observation', async () => {
  const f = fixture();
  for (const body of [{ sessionId: '../credentials' }, { sessionId: 'a/b' }, { sessionId: 'a\\b' }, { sessionId: '..' }, { sessionId: '' }, { sessionId: 'a\u0000b' }, { sessionId: 'x', path: '/private' }, [], null]) {
    assert.equal((await f.call('session', body)).status, 400);
  }
  assert.equal((await f.call('session', '{broken')).status, 400);
  assert.equal((await f.call('session', '"' + 'x'.repeat(5000) + '"')).status, 413);
  assert.equal((await f.call('session', { sessionId: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  for (const body of [{ fromMs: -1 }, { fromMs: 10, toMs: 9 }, { timeZone: 'Not/AZone' }, { cursor: 1 }, { pinSessionId: '/private/path' }, { groupBy: 'day' }]) {
    assert.equal((await f.call('query', body)).status, 400);
  }
  assert.equal(f.calls.length, 0); f.host.dispose();
});

test('safe errors never expose source exceptions or unrecognized error codes', async () => {
  const f = fixture({ query() { throw Object.assign(new Error('SECRET_REQUEST_BODY'), { code: 'STALE_CURSOR' }); }, session() { throw Object.assign(new Error('SECRET_KEY'), { code: '/private/path' }); } });
  const stale = await f.call('query', {}); assert.equal(stale.status, 409); assert.deepEqual(stale.data, { ok: false, error: { code: 'STALE_CURSOR' } });
  const fail = await f.call('session', { sessionId: 'x' }); assert.equal(fail.status, 500); assert.deepEqual(fail.data, { ok: false, error: { code: 'INTERNAL' } });
  assert.doesNotMatch(JSON.stringify([stale.data, fail.data]), /SECRET|private|path/); f.host.dispose();
});

test('passes cancellation signal and disposal disables retained handlers before further reads', async () => {
  const f = fixture(); const controller = new AbortController();
  const response = await f.call('session', { sessionId: 'x' }, {}, controller.signal); assert.equal(response.status, 200);
  assert.equal(f.calls[0][2] instanceof AbortSignal, true);
  const retained = f.routes.get('/api/local-usage-dashboard/session'); const before = f.calls.length;
  f.host.dispose(); assert.equal(f.routes.size, 0);
  const result = await retained.fetch(f.request()); assert.equal(result.status, 503);
  assert.equal(f.calls.length, before + 1); assert.deepEqual(f.calls.at(-1), ['dispose']);
});

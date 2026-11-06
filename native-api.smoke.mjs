// Bundled Electron-as-Node only. New isolated Context, in-memory synthetic
// sessions/auth. No profile, credentials, listener, network or real log reads.
import assert from 'node:assert/strict';
import * as usage from './index.js';
const base = 'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/';
globalThis.fetch = () => { throw new Error('Network forbidden in offline fixture'); };
const { Context } = await import(base + '@deepseek-ai/cordis/lib/index.js');
const { SessionStore } = await import(base + '@deepseek-ai/dsh-session/lib/index.js');
const { SessionQueryEngine } = await import(base + '@deepseek-ai/dsh-session-query/lib/index.js');
const { HostConnectionService } = await import(base + '@deepseek-ai/dsh-client-connection/lib/index.js');
const ctx = new Context();
const sessionsFiber = ctx.plugin(SessionStore);
const queryFiber = ctx.plugin(SessionQueryEngine);
const connection = new HostConnectionService(ctx, [], {
  isAuthenticated: request => request.headers.get('x-test-owner') === 'yes',
  authenticateApi: () => undefined,
});
await new Promise(setImmediate);
const seed = [
  { type: 'request/header', seq: 0, time: 1_700_000_000_000, data: { reason: 'initial', header: { config: { provider: 'openai', model: 'gpt-4.1' }, messages: [] } } },
  { type: 'assistant/message', surfaceOp: 'append', seq: 1, time: 1_700_000_001_000, data: { turn: 1, step: 1, stream: [], message: { id: 'fixture-message-1', role: 'assistant', content: [{ type: 'text', text: 'DO_NOT_RETURN_PRIVATE_BODY' }], source: { kind: 'model', provider: 'openai', model: 'gpt-4.1' } }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
];
ctx.sessions.create('usage-fixture-parent', { seed });
const child = ctx.sessions.create('usage-fixture-child', { meta: { isSeeded: true }, inheritedEventCount: 2, seed });
child.append('assistant/message', {
  turn: 2, step: 1, stream: [], message: { id: 'fixture-message-2', role: 'assistant', content: [{ type: 'text', text: 'DO_NOT_RETURN_CHILD_BODY' }], source: { kind: 'model', provider: 'openai', model: 'gpt-4.1' } }, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
}, { surfaceOp: 'append' });
const hostFiber = ctx.plugin(usage);
await new Promise(setImmediate);
await hostFiber.await();
const handler = connection.createSharedFetchHandler('/api');
function request(action, body, owner = true, origin) {
  return new Request('http://dsh.internal/api/local-usage-dashboard/' + action, { method: 'POST', headers: {
    host: '127.0.0.1:59907', 'content-type': 'application/json', 'x-dsh-usage': '1',
    ...(owner ? { 'x-test-owner': 'yes' } : {}), ...(origin ? { origin } : {}),
  }, body: JSON.stringify(body) });
}
async function call(action, body, origin) {
  const req = request(action, body, true, origin); const admission = connection.admit(req);
  assert.ok(admission.peer);
  const response = await handler.fetch(req, admission.peer); const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value)); assert.equal(value.ok, true);
  assert.doesNotMatch(JSON.stringify(value), /DO_NOT_RETURN|PRIVATE_BODY|messages|content|cwd|credential/i);
  return value;
}
try {
  assert.equal(connection.admit(request('query', {}, false)).rejection, 401);
  const forbidden = await handler.fetch(request('query', {}), { principal: { kind: 'external' } });
  assert.equal(forbidden.status, 403);
  const one = await call('session', { sessionId: 'usage-fixture-child' });
  assert.equal(one.session.metrics.observedCalls, 1);
  assert.equal(one.session.metrics.tokens.totalTokens, 12);
  assert.equal(one.session.metrics.coverage, 'complete');
  const page = await call('query', { timeZone: 'Europe/Warsaw' }, 'http://127.0.0.1:59907');
  assert.equal(page.page.rows.length, 2); assert.equal(page.page.complete, true);
  assert.equal(page.page.rows.reduce((n, row) => n + row.metrics.tokens.totalTokens, 0), 132);
  // Repeated real Cordis-traced service lookups must not make cursors stale.
  const again = await call('session', { sessionId: 'usage-fixture-parent' });
  assert.equal(again.session.metrics.tokens.totalTokens, 120);
  console.log('PASS actual SDK: plugin fiber + Connection owner gate + native SessionStore/SessionQuery, own fork accounting, repeated traced lookups, sanitized DTO. Synthetic memory only.');
} finally {
  await hostFiber.dispose(); await queryFiber.dispose(); await sessionsFiber.dispose();
}

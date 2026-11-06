import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createMetricTools } from './metrics.js';

const catalog = { excludedProviders: ['openai-codex'], models: [
  { provider: 'api', model: 'm', cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 } },
  { provider: 'api', model: 'tiered', cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3, tiers: [{ inputTokensAbove: 10, input: 4, output: 16, cacheRead: 1, cacheWrite: 6 }] } },
  { provider: 'api', model: 'synthetic', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
] };
const tools = createMetricTools(catalog);
const sample = (raw, provider = 'api', model = 'm') => ({ id: '1:1:0', turn: 1, step: 1, attempt: 0, timeMs: 1000, provider, model, ...tools.normalizeUsage(raw) });
const raw = (inputTokens = 100, outputTokens = 20) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-12, `${value} != ${expected}`);

test('normalizes disjoint cache buckets, authoritative totals and reasoning subset without double counting', () => {
  const result = tools.normalizeUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 2, totalTokens: 21, reasoningTokens: 3, secret: 'NEVER_COPY' });
  assert.equal(result.sample, 'reported');
  assert.deepEqual(result.tokens, { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 2, totalTokens: 21, reasoningTokens: 3 });
  assert.doesNotMatch(JSON.stringify(result), /NEVER_COPY|secret/);
});

test('missing cache is not zero unless a full reported total proves it', () => {
  const unknown = tools.normalizeUsage({ inputTokens: 10, outputTokens: 2 });
  assert.equal(unknown.sample, 'reported'); assert.equal(unknown.tokens.cacheReadTokens, null); assert.equal(unknown.tokens.totalTokens, null);
  const exact = tools.normalizeUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  assert.equal(exact.tokens.cacheReadTokens, 0); assert.equal(exact.tokens.cacheWriteTokens, 0);
  const one = tools.normalizeUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, totalTokens: 16 });
  assert.equal(one.tokens.cacheWriteTokens, 3);
  const splitUnknown = tools.normalizeUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 16 });
  assert.equal(splitUnknown.tokens.cacheReadTokens, null); assert.equal(splitUnknown.tokens.cacheWriteTokens, null); assert.equal(splitUnknown.tokens.totalTokens, 16);
});

test('observed zero differs from no sample and invalid counters never become zero', () => {
  assert.equal(tools.normalizeUsage(undefined).sample, 'missing');
  const zero = tools.normalizeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(zero.sample, 'reported'); assert.equal(zero.tokens.totalTokens, 0);
  for (const value of [null, [], {}, { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1, outputTokens: Infinity },
    { ...raw(), cacheReadTokens: -2 }, { ...raw(), reasoningTokens: 21 }, { ...raw(), totalTokens: 119 },
    { ...raw(), totalTokens: 121 }, { ...raw(), cacheWriteTokens: 'PRIVATE' }]) {
    assert.deepEqual(tools.normalizeUsage(value), { sample: 'invalid', tokens: null });
  }
});

test('prices each call in USD per million and does not charge reasoning a second time', () => {
  const result = tools.summarize([sample({ ...raw(1_000_000, 500_000), reasoningTokens: 100_000 })]);
  near(result.cost.estimatedUSD, 6); assert.equal(result.cost.mode, 'estimate'); assert.equal(result.cost.complete, true);
  assert.equal(result.tokens.totalTokens, 1_500_000);
});

test('tier threshold is strict greater-than and applies per-call, not aggregate', () => {
  const at = sample(raw(10, 1), 'api', 'tiered');
  const above = sample(raw(11, 1), 'api', 'tiered');
  near(tools.summarize([at]).cost.estimatedUSD, 28 / 1e6);
  near(tools.summarize([above]).cost.estimatedUSD, 60 / 1e6);
  near(tools.summarize([at, at]).cost.estimatedUSD, 56 / 1e6);
});

test('unknown routes, synthetic all-zero rates and ambiguous cache-write duration do not claim free or priced usage', () => {
  for (const call of [sample(raw(), 'alias', 'm'), sample(raw(), 'api', 'missing'), sample(raw(), 'api', 'synthetic'),
    sample({ inputTokens: 10, outputTokens: 2 }), sample({ ...raw(), cacheWriteTokens: 4 })]) {
    const result = tools.summarize([call]);
    assert.equal(result.cost.estimatedUSD, null); assert.equal(result.cost.mode, 'unknown'); assert.equal(result.cost.complete, false);
  }
});

test('selected all-zero tier is unknown rather than a false free-call quote', () => {
  const tierTools = createMetricTools({ models: [{ provider: 'api', model: 'm', cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3, tiers: [{ inputTokensAbove: 10, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }] } }] });
  const result = tierTools.summarize([sample(raw(11, 1))]);
  assert.equal(result.cost.estimatedUSD, null); assert.equal(result.cost.unknownCalls, 1); assert.equal(result.cost.complete, false);
});

test('subscription-route is a conservative presentation policy, never a dollar invoice or OAuth proof', () => {
  const result = tools.summarize([sample(raw(), 'openai-codex', 'm')]);
  assert.equal(result.cost.mode, 'subscription-route'); assert.equal(result.cost.estimatedUSD, null); assert.equal(result.cost.excludedCalls, 1);
  assert.equal('verifiedOAuth' in result, false);
});

test('mixed and partially observed requests retain honest coverage and known subtotal', () => {
  const calls = [sample(raw(1_000_000, 500_000)), sample(raw(), 'openai-codex'), sample(undefined)];
  const result = tools.summarize(calls);
  assert.equal(result.observedCalls, 2); assert.equal(result.missingCalls, 1); assert.equal(result.coverage, 'partial');
  assert.equal(result.cost.mode, 'mixed'); near(result.cost.estimatedUSD, 6);
  assert.equal(result.cost.unknownCalls, 1); assert.equal(result.cost.complete, false);
  const missingOnly = tools.summarize([sample(undefined)]);
  assert.equal(missingOnly.coverage, 'unavailable'); assert.equal(missingOnly.tokens.uncachedInputTokens, null);
});

test('merging session metrics equals per-call aggregation without inventing missing optional detail', () => {
  const a = [sample(raw(3, 2))]; const b = [sample({ inputTokens: 5, outputTokens: 1, totalTokens: 8 }), sample(undefined)];
  assert.deepEqual(tools.mergeMetrics([tools.summarize(a), tools.summarize(b)]), tools.summarize([...a, ...b]));
  assert.equal(tools.mergeMetrics([tools.summarize(a), tools.summarize(b)]).tokens.cacheReadTokens, null);
  const incomplete = tools.summarize(a); incomplete.coverage = 'partial'; incomplete.cost.complete = false;
  assert.equal(tools.mergeMetrics([incomplete]).coverage, 'partial');
});

test('empty and unsafe aggregate counts remain unavailable or partial, never wrapped integers', () => {
  assert.deepEqual(tools.summarize([]), tools.emptyMetrics());
  const huge = sample(raw(Number.MAX_SAFE_INTEGER, 0));
  const result = tools.summarize([huge, huge]);
  assert.equal(result.tokens.uncachedInputTokens, null); assert.equal(result.tokens.totalTokens, null); assert.equal(result.coverage, 'partial');
  assert.equal(result.cost.complete, false);
});

test('retained earlier usage after an incomplete final settlement stays explicitly partial', () => {
  const call = { ...sample(raw()), incomplete: true };
  const result = tools.summarize([call]);
  assert.equal(result.observedCalls, 1); assert.equal(result.tokens.totalTokens, 120);
  assert.equal(result.coverage, 'partial'); assert.equal(result.cost.complete, false);
});

test('factory is browser-embeddable and has no external imports or closure dependencies', () => {
  const browser = vm.runInNewContext(`(${createMetricTools.toString()})()`);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.emptyMetrics())), createMetricTools().emptyMetrics());
  assert.equal(browser.normalizeUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }).sample, 'reported');
});

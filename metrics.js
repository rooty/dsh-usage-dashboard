// Self-contained: shared Host arithmetic and browser aggregation, no free variables.
export function createMetricTools(catalog = {}) {
  const fields = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
  const isCount = value => Number.isSafeInteger(value) && value >= 0;
  const isRate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
  const none = () => Object.fromEntries(fields.map(key => [key, null]));
  const sum = values => {
    let total = 0;
    for (const value of values) { if (!isCount(value) || !isCount(total + value)) return null; total += value; }
    return total;
  };
  const emptyMetrics = () => ({ observedCalls: 0, missingCalls: 0, invalidCalls: 0, coverage: 'unavailable', tokens: none(), cost: { mode: 'unknown', estimatedUSD: null, estimatedCalls: 0, excludedCalls: 0, unknownCalls: 0, complete: false } });
  function normalizeUsage(raw) {
    if (raw === undefined) return { sample: 'missing', tokens: null };
    const invalid = () => ({ sample: 'invalid', tokens: null });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isCount(raw.inputTokens) || !isCount(raw.outputTokens)) return invalid();
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) if (raw[key] !== undefined && !isCount(raw[key])) return invalid();
    if (raw.reasoningTokens !== undefined && raw.reasoningTokens > raw.outputTokens) return invalid();
    let read = raw.cacheReadTokens ?? null, write = raw.cacheWriteTokens ?? null;
    const known = sum([raw.inputTokens, raw.outputTokens, ...(read === null ? [] : [read]), ...(write === null ? [] : [write])]);
    if (known === null) return invalid();
    let total = raw.totalTokens ?? (read !== null && write !== null ? known : null);
    if (total !== null) {
      if (total < known || (read !== null && write !== null && total !== known)) return invalid();
      const rest = total - known;
      if (read === null && write === null && rest === 0) { read = 0; write = 0; }
      else if (read === null && write !== null) read = rest;
      else if (write === null && read !== null) write = rest;
    }
    return { sample: 'reported', tokens: { uncachedInputTokens: raw.inputTokens, outputTokens: raw.outputTokens, cacheReadTokens: read, cacheWriteTokens: write, reasoningTokens: raw.reasoningTokens ?? null, totalTokens: total } };
  }
  const excluded = new Set(['openai-codex', ...(Array.isArray(catalog.excludedProviders) ? catalog.excludedProviders.filter(value => typeof value === 'string') : [])]);
  const prices = new Map();
  for (const row of Array.isArray(catalog.models) ? catalog.models : []) {
    if (typeof row?.provider !== 'string' || typeof row?.model !== 'string') continue;
    const key = JSON.stringify([row.provider, row.model]);
    // Ambiguous protocol variants must not silently pick a cheaper rate.
    if (prices.has(key)) prices.set(key, null); else prices.set(key, row.cost);
  }
  const rateKeys = ['input', 'output', 'cacheRead', 'cacheWrite'];
  function quote(call) {
    if (excluded.has(call?.provider)) return { kind: 'excluded', amount: null };
    if (call?.sample !== 'reported' || !call.tokens) return { kind: 'unknown', amount: null };
    const usage = call.tokens;
    if (![usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].every(isCount)) return { kind: 'unknown', amount: null };
    // Normalized DSH usage loses cacheWrite1h duration; no invented default TTL.
    if (usage.cacheWriteTokens > 0) return { kind: 'unknown', amount: null };
    let rate = prices.get(JSON.stringify([call.provider, call.model]));
    if (!rate || !rateKeys.every(key => isRate(rate[key])) || rateKeys.every(key => rate[key] === 0)) return { kind: 'unknown', amount: null };
    const prompt = sum([usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]);
    if (prompt === null) return { kind: 'unknown', amount: null };
    if (rate.tiers !== undefined) {
      if (!Array.isArray(rate.tiers) || rate.tiers.some(tier => !isCount(tier?.inputTokensAbove) || !rateKeys.every(key => isRate(tier[key])))) return { kind: 'unknown', amount: null };
      const matches = rate.tiers.filter(tier => prompt > tier.inputTokensAbove).sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
      if (matches.length) rate = matches[matches.length - 1];
    }
    if (rateKeys.every(key => rate[key] === 0)) return { kind: 'unknown', amount: null };
    const amount = (usage.uncachedInputTokens * rate.input + usage.outputTokens * rate.output + usage.cacheReadTokens * rate.cacheRead + usage.cacheWriteTokens * rate.cacheWrite) / 1_000_000;
    return Number.isFinite(amount) && amount >= 0 ? { kind: 'estimate', amount } : { kind: 'unknown', amount: null };
  }
  const costMode = (estimated, excludedCalls, unknown) => {
    if (estimated > 0 && excludedCalls === 0 && unknown === 0) return 'estimate';
    if (excludedCalls > 0 && estimated === 0 && unknown === 0) return 'subscription-route';
    if ((estimated > 0 && excludedCalls > 0) || (unknown > 0 && estimated + excludedCalls > 0)) return 'mixed';
    return 'unknown';
  };
  function summarize(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return emptyMetrics();
    const result = emptyMetrics(); const reported = [];
    let amount = 0;
    for (const call of calls) {
      if (call?.sample === 'reported' && call.tokens && isCount(call.tokens.uncachedInputTokens) && isCount(call.tokens.outputTokens)) {
        result.observedCalls++; reported.push(call.tokens);
      } else if (call?.sample === 'missing') result.missingCalls++;
      else result.invalidCalls++;
      const priced = quote(call);
      if (priced.kind === 'estimate') { result.cost.estimatedCalls++; amount += priced.amount; }
      else if (priced.kind === 'excluded') result.cost.excludedCalls++;
      else result.cost.unknownCalls++;
    }
    let overflow = false;
    if (reported.length) for (const key of fields) {
      if (reported.every(tokens => isCount(tokens[key]))) {
        result.tokens[key] = sum(reported.map(tokens => tokens[key]));
        if (result.tokens[key] === null) overflow = true;
      }
    }
    result.coverage = reported.length === 0 ? 'unavailable' : result.missingCalls + result.invalidCalls > 0 || overflow || calls.some(call => call?.incomplete === true) ? 'partial' : 'complete';
    result.cost.estimatedUSD = result.cost.estimatedCalls > 0 && Number.isFinite(amount) ? amount : null;
    result.cost.mode = costMode(result.cost.estimatedCalls, result.cost.excludedCalls, result.cost.unknownCalls);
    result.cost.complete = result.coverage === 'complete' && result.cost.estimatedCalls > 0 && result.cost.unknownCalls === 0 && result.cost.excludedCalls === 0 && result.cost.estimatedUSD !== null;
    return result;
  }
  function mergeMetrics(items) {
    if (!Array.isArray(items) || items.length === 0) return emptyMetrics();
    const valid = items.filter(Boolean);
    if (valid.length === 0) return emptyMetrics();
    for (const row of valid) {
      if (![row.observedCalls, row.missingCalls, row.invalidCalls, row.cost?.estimatedCalls, row.cost?.excludedCalls, row.cost?.unknownCalls].every(isCount)
        || !['complete', 'partial', 'unavailable'].includes(row.coverage) || !row.tokens || !row.cost
        || !fields.every(key => row.tokens[key] === null || isCount(row.tokens[key]))
        || !(row.cost.estimatedUSD === null || typeof row.cost.estimatedUSD === 'number' && Number.isFinite(row.cost.estimatedUSD) && row.cost.estimatedUSD >= 0)) throw new Error('Invalid usage aggregate');
    }
    const result = emptyMetrics();
    for (const key of ['observedCalls', 'missingCalls', 'invalidCalls']) {
      const value = sum(valid.map(row => row[key]));
      if (value === null) throw new Error('Usage count overflow');
      result[key] = value;
    }
    const active = valid.filter(row => row.observedCalls > 0);
    let overflow = false;
    if (active.length) for (const key of fields) if (active.every(row => isCount(row.tokens[key]))) {
      result.tokens[key] = sum(active.map(row => row.tokens[key]));
      if (result.tokens[key] === null) overflow = true;
    }
    for (const key of ['estimatedCalls', 'excludedCalls', 'unknownCalls']) {
      const value = sum(valid.map(row => row.cost[key]));
      if (value === null) throw new Error('Usage count overflow');
      result.cost[key] = value;
    }
    const amount = valid.reduce((total, row) => total + (row.cost.estimatedUSD ?? 0), 0);
    result.cost.estimatedUSD = result.cost.estimatedCalls > 0 && valid.every(row => row.cost.estimatedCalls === 0 || row.cost.estimatedUSD !== null) && Number.isFinite(amount) ? amount : null;
    result.coverage = result.observedCalls === 0 ? 'unavailable' : overflow || valid.some(row => row.coverage === 'partial') || result.missingCalls + result.invalidCalls > 0 ? 'partial' : 'complete';
    result.cost.mode = costMode(result.cost.estimatedCalls, result.cost.excludedCalls, result.cost.unknownCalls);
    result.cost.complete = result.coverage === 'complete' && result.cost.estimatedCalls > 0 && result.cost.excludedCalls + result.cost.unknownCalls === 0 && result.cost.estimatedUSD !== null && valid.every(row => row.observedCalls + row.missingCalls + row.invalidCalls === 0 || row.cost.complete);
    return result;
  }
  return { normalizeUsage, summarize, mergeMetrics, emptyMetrics };
}

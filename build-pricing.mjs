// Build-time PUBLIC CODE extraction only. Never import model discovery/auth or
// inspect user settings. Default archive path needs bundled Electron-as-Node.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = process.argv[2] || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@earendil-works/pi-ai';
const sdk = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const dsh = JSON.parse(await readFile(resolve(root, '../../@deepseek-ai/dsh-llm-pi-ai/package.json'), 'utf8'));
if (sdk.version !== '1.3.0' || dsh.version !== '0.2.2-rc.1') throw new Error('Revalidate the pricing contract for this SDK release');
const rateKeys = ['input', 'output', 'cacheRead', 'cacheWrite'];
const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
function costOf(value) {
  if (!value || !rateKeys.every(key => rate(value[key]))) return null;
  const result = Object.fromEntries(rateKeys.map(key => [key, value[key]]));
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers) || value.tiers.some(row => !Number.isSafeInteger(row?.inputTokensAbove) || row.inputTokensAbove < 0 || !rateKeys.every(key => rate(row[key])))) return null;
    result.tiers = value.tiers.map(row => ({ inputTokensAbove: row.inputTokensAbove, ...Object.fromEntries(rateKeys.map(key => [key, row[key]])) })).sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
  }
  return result;
}
const models = new Map();
for (const filename of (await readdir(join(root, 'dist/providers/data'))).filter(name => !name.startsWith('.') && /^[a-z0-9-]+\.json$/.test(name)).sort()) {
  const data = JSON.parse(await readFile(join(root, 'dist/providers/data', filename), 'utf8'));
  for (const group of Object.values(data)) for (const model of Object.values(group || {})) {
    if (model?.type !== 'chat' || typeof model.provider !== 'string' || typeof model.id !== 'string') continue;
    const key = JSON.stringify([model.provider, model.id]);
    const cost = costOf(model.cost);
    const old = models.get(key);
    if (old && JSON.stringify(old.cost) !== JSON.stringify(cost)) old.cost = null;
    else if (!old) models.set(key, { provider: model.provider, model: model.id, cost });
  }
}
const output = {
  source: 'pi-ai-catalog', dshVersion: dsh.version, catalogVersion: sdk.version, currency: 'USD', estimateOnly: true,
  currencyContract: 'https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/rpc-commands.md',
  excludedProviders: ['openai-codex', 'github-copilot', 'google-gemini-cli', 'google-antigravity', 'kimi-coding', 'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp'],
  models: [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
};
await writeFile(new URL('./pricing.json', import.meta.url), JSON.stringify(output) + '\n');
console.log(`Built sanitized catalog: ${output.models.length} exact route/model entries; ${output.models.filter(row => row.cost === null).length} ambiguous/unknown rates. No auth, model discovery or network.`);

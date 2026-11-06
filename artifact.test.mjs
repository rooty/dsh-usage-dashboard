import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('built artifact uses only provided React and registers native sidebar/main/session dock without rendering', async () => {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  let module; const imports = [], slots = [], navigation = [];
  const context = vm.createContext({ window: { __ModuleLoader__: { load(value) { module = value; } } }, Intl, AbortController, URL, Map, Set });
  vm.runInContext(source, context);
  assert.equal(module.id, '@local/dsh-usage-dashboard');
  const plugin = module.factory(name => { imports.push(name); assert.equal(name, 'react'); return { createElement() { throw new Error('This fixture must not emulate a GUI renderer'); } }; });
  assert.deepEqual(imports, ['react']);
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale', 'layout', 'uiSession']);
  plugin.apply({
    locale: { register() { return () => {}; }, bind() { return key => key; } },
    effect(run) { return run(); },
    slots: { inject(_name, callback) { return callback(); }, register(options) { slots.push(options); return () => {}; } },
    layout: { selectPanel(id) { navigation.push(id); } }, uiSession: { current: { getSnapshot: () => ({ key: undefined }), subscribe: () => () => {} } },
  });
  assert.deepEqual(slots.map(row => row.name), ['main', 'sidebar.panellist', 'conversation.composer.dock']);
  assert.equal(slots[0].key, 'local.usage'); assert.equal(slots[1].id, 'local.usage');
  assert.equal(slots[2].id, 'local.usage-dashboard'); assert.notEqual(slots[2].id, 'usage');
  const page = slots[0].inject();
  assert.equal(typeof page.onClose, 'function', 'Usage page must expose return-to-chat action');
  page.onClose();
  assert.deepEqual(navigation, [null], 'Close selects Conversation, never terminates or switches the Session');
  assert.equal(plugin.numberText(null), '—');
  assert.doesNotMatch(source, /__METRIC_TOOLS__|^import\s|^export\s/m);
});

test('catalog artifact is sanitized, versioned and contains no endpoint/config/credential fields', async () => {
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  const pricing = JSON.parse(await readFile(new URL('./pricing.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.dsh, pricing.dshVersion); assert.equal(pricing.catalogVersion, '1.3.0'); assert.equal(pricing.currency, 'USD');
  assert.equal(pricing.estimateOnly, true); assert.ok(pricing.models.length > 0);
  for (const row of pricing.models) assert.deepEqual(Object.keys(row), ['provider', 'model', 'cost']);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(pricing.excludedProviders.includes('openai-codex'), true);
});

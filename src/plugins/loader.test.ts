import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlugins } from './loader.js';

function tempPluginDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'pod-plugins-test-'));
}

const VALID_DESCRIPTOR = {
  id: 'from-json',
  name: 'From JSON',
  charityName: 'From JSON Charity',
  description: 'A charity loaded from a JSON plugin file, for testing purposes.',
  supportedCurrencies: ['USD'],
  donateLink: 'https://donate.json-charity.example/give',
  currency: 'USD',
  trustedDkimDomains: ['json-charity.example'],
  subjectPattern: 'donation',
  amountPattern: 'amount:\\s*\\$?([\\d.]+)',
  datePattern: 'date:\\s*(.+)'
};

test('always includes the bundled plugins/salvation-army.json plugin, even with no extra dirs', async () => {
  const plugins = await loadPlugins();
  assert.ok(plugins.some((p) => p.id === 'salvation-army'));
});

test('loads a .json file in a plugin directory as one or more RegexPlugins', async () => {
  const dir = tempPluginDir();
  try {
    writeFileSync(path.join(dir, 'charity.json'), JSON.stringify([VALID_DESCRIPTOR]));
    const plugins = await loadPlugins({ pluginDirs: [dir] });
    const found = plugins.find((p) => p.id === 'from-json');
    assert.ok(found);
    assert.deepEqual(found?.trustedDkimDomains, ['json-charity.example']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loads a .js file in a plugin directory as a code-based ReceiptPlugin (default export)', async () => {
  const dir = tempPluginDir();
  try {
    writeFileSync(
      path.join(dir, 'code-plugin.js'),
      `module.exports = {
        id: 'from-js',
        name: 'From JS',
        trustedDkimDomains: ['code-charity.example'],
        charityInfo: {
          charityName: 'From JS Charity',
          description: 'A charity loaded from a code plugin, for testing purposes.',
          supportedCurrencies: ['USD'],
          donateLink: 'https://donate.code-charity.example/give'
        },
        parse(message) { return null; }
      };`
    );
    const plugins = await loadPlugins({ pluginDirs: [dir] });
    assert.ok(plugins.some((p) => p.id === 'from-js'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loads a .js file exporting a named `plugin` instead of a default export', async () => {
  const dir = tempPluginDir();
  try {
    writeFileSync(
      path.join(dir, 'named-export.js'),
      `exports.plugin = {
        id: 'from-js-named',
        name: 'From JS Named',
        trustedDkimDomains: ['named-charity.example'],
        charityInfo: {
          charityName: 'From JS Named Charity',
          description: 'A charity loaded from a named-export code plugin, for testing purposes.',
          supportedCurrencies: ['USD'],
          donateLink: 'https://donate.named-charity.example/give'
        },
        parse(message) { return null; }
      };`
    );
    const plugins = await loadPlugins({ pluginDirs: [dir] });
    assert.ok(plugins.some((p) => p.id === 'from-js-named'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recurses into subdirectories of a plugin directory', async () => {
  const dir = tempPluginDir();
  try {
    const nested = path.join(dir, 'nested', 'deeper');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(dir, 'top-level.json'), JSON.stringify([{ ...VALID_DESCRIPTOR, id: 'top-level' }]));
    writeFileSync(path.join(dir, 'nested', 'one-level-down.json'), JSON.stringify([{ ...VALID_DESCRIPTOR, id: 'one-level-down' }]));
    writeFileSync(path.join(nested, 'two-levels-down.json'), JSON.stringify([{ ...VALID_DESCRIPTOR, id: 'two-levels-down' }]));

    const plugins = await loadPlugins({ pluginDirs: [dir] });
    const ids = plugins.map((p) => p.id);
    assert.ok(ids.includes('top-level'));
    assert.ok(ids.includes('one-level-down'));
    assert.ok(ids.includes('two-levels-down'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ignores files with unrelated extensions in a plugin directory', async () => {
  const dir = tempPluginDir();
  try {
    writeFileSync(path.join(dir, 'README.md'), '# not a plugin');
    writeFileSync(path.join(dir, 'charity.json'), JSON.stringify([VALID_DESCRIPTOR]));
    const plugins = await loadPlugins({ pluginDirs: [dir] });
    assert.equal(plugins.length, 2); // salvation-army (bundled) + from-json
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws a clear error for a .json file that is not valid JSON', async () => {
  const dir = tempPluginDir();
  try {
    writeFileSync(path.join(dir, 'broken.json'), '{ not valid json');
    await assert.rejects(() => loadPlugins({ pluginDirs: [dir] }), /is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws a clear error for a .json file that is not an array', async () => {
  const dir = tempPluginDir();
  try {
    writeFileSync(path.join(dir, 'not-array.json'), JSON.stringify(VALID_DESCRIPTOR));
    await assert.rejects(() => loadPlugins({ pluginDirs: [dir] }), /must contain a JSON array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws a clear error for a .js file that does not export a valid ReceiptPlugin', async () => {
  const dir = tempPluginDir();
  try {
    writeFileSync(path.join(dir, 'bad-plugin.js'), `module.exports = { not: 'a plugin' };`);
    await assert.rejects(() => loadPlugins({ pluginDirs: [dir] }), /does not export a valid ReceiptPlugin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws on duplicate plugin ids across directories', async () => {
  const dir = tempPluginDir();
  try {
    writeFileSync(path.join(dir, 'dup.json'), JSON.stringify([{ ...VALID_DESCRIPTOR, id: 'salvation-army' }]));
    await assert.rejects(() => loadPlugins({ pluginDirs: [dir] }), /Duplicate plugin id "salvation-army"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws a clear error when an explicitly-configured plugin directory does not exist', async () => {
  await assert.rejects(
    () => loadPlugins({ pluginDirs: ['/nonexistent/path/that/should/not/exist'] }),
    /Could not read plugin directory/
  );
});

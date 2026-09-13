import { readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ReceiptPlugin } from './plugin.js';
import { compileRegexPlugin } from './regex-plugin.js';
import type { RegexPluginDescriptor } from './regex-plugin.js';

export interface PluginLoadOptions {
  /**
   * Directories to load plugins from, in addition to the bundled plugins/ directory (always
   * included). Each directory is scanned recursively (including any subdirectories):
   *  - every `.json` file is parsed as a JSON array of RegexPluginDescriptor objects (see
   *    regex-plugin.ts) -- the default, recommended way to add a plugin.
   *  - every `.js` file is dynamically imported as a code-based ReceiptPlugin (its default
   *    or named `plugin` export) -- the advanced escape hatch for a template a RegexPlugin
   *    can't express. Unlike a JSON file, a `.js` file runs as trusted code with full
   *    Node.js access -- only point this at directories you trust.
   */
  pluginDirs?: string[];
}

// plugins/ sits at the repo root, alongside src/ and dist/ -- this resolves to it regardless
// of the process's current working directory, since dist/plugins/loader.js is always two
// directories below the repo root.
const BUNDLED_PLUGINS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins');

function loadJsonPluginFile(filePath: string): ReceiptPlugin[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read plugin file "${filePath}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Plugin file "${filePath}" is not valid JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Plugin file "${filePath}" must contain a JSON array of plugin descriptors`);
  }

  return parsed.map((descriptor, i) => {
    try {
      return compileRegexPlugin(descriptor as RegexPluginDescriptor);
    } catch (err) {
      throw new Error(`Plugin file "${filePath}", entry ${i}: ${(err as Error).message}`);
    }
  });
}

function isReceiptPlugin(value: unknown): value is ReceiptPlugin {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    Array.isArray(p.trustedDkimDomains) &&
    p.trustedDkimDomains.every((d) => typeof d === 'string') &&
    typeof p.parse === 'function'
  );
}

async function loadJsPluginFile(filePath: string): Promise<ReceiptPlugin> {
  const mod = await import(pathToFileURL(filePath).href);
  // For a CommonJS module (the default for a lone .js file with no governing package.json),
  // Node synthesizes `default` as the *entire* module.exports object -- so a named `exports.
  // plugin = ...` export shows up as both `mod.default.plugin` and `mod.plugin`, while
  // `mod.default` itself is just the wrapper, not the plugin. Prefer `plugin` when it's
  // itself a valid ReceiptPlugin; only fall back to `default` otherwise.
  const candidate = isReceiptPlugin(mod.plugin) ? mod.plugin : mod.default;
  if (!isReceiptPlugin(candidate)) {
    throw new Error(`Plugin module "${filePath}" does not export a valid ReceiptPlugin as its default (or "plugin") export`);
  }
  return candidate;
}

async function loadPluginDir(dir: string, required: boolean): Promise<ReceiptPlugin[]> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!required) return [];
    throw new Error(`Could not read plugin directory "${dir}": ${(err as Error).message}`);
  }

  const plugins: ReceiptPlugin[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      plugins.push(...(await loadPluginDir(entryPath, required)));
    } else if (entry.name.endsWith('.json')) {
      plugins.push(...loadJsonPluginFile(entryPath));
    } else if (entry.name.endsWith('.js')) {
      plugins.push(await loadJsPluginFile(entryPath));
    }
  }
  return plugins;
}

export async function loadPlugins(opts: PluginLoadOptions = {}): Promise<ReceiptPlugin[]> {
  const dirs = [
    { dir: BUNDLED_PLUGINS_DIR, required: false },
    ...(opts.pluginDirs ?? []).map((dir) => ({ dir, required: true }))
  ];

  const plugins: ReceiptPlugin[] = [];
  for (const { dir, required } of dirs) {
    plugins.push(...(await loadPluginDir(dir, required)));
  }

  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) {
      throw new Error(`Duplicate plugin id "${plugin.id}"`);
    }
    seen.add(plugin.id);
  }

  return plugins;
}

import type { ReceiptPlugin } from '../types.js';
import { builtinPlugins } from './builtin/index.js';

export interface PluginLoadOptions {
  /** If set, only builtin plugins with these ids are enabled (default: all builtin plugins). */
  enabledBuiltins?: string[];
  /**
   * Absolute paths or npm package specifiers to dynamically import as external plugins.
   * Each module's default export (or named `plugin` export) must be a ReceiptPlugin.
   * These run as trusted code with full Node.js access -- only install plugins you trust,
   * the same way you'd trust any other npm dependency or server-side code.
   */
  externalModules?: string[];
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

export async function loadPlugins(opts: PluginLoadOptions = {}): Promise<ReceiptPlugin[]> {
  const plugins: ReceiptPlugin[] = opts.enabledBuiltins
    ? builtinPlugins.filter((p) => opts.enabledBuiltins!.includes(p.id))
    : [...builtinPlugins];

  for (const spec of opts.externalModules ?? []) {
    const mod = await import(spec);
    const candidate = mod.default ?? mod.plugin;
    if (!isReceiptPlugin(candidate)) {
      throw new Error(`External plugin module "${spec}" does not export a valid ReceiptPlugin as its default (or "plugin") export`);
    }
    plugins.push(candidate);
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

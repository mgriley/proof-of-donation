export interface Config {
  port: number;
  /** Extra directories to load plugins from, in addition to the bundled plugins/ directory. */
  pluginDirs: string[];
  /** If true, skip the bundled plugins/ directory entirely -- only pluginDirs are loaded. */
  excludeBuiltins: boolean;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number.parseInt(env.PORT ?? '8787', 10),
    pluginDirs: splitList(env.PLUGIN_DIRS) ?? [],
    excludeBuiltins: env.DISABLE_BUNDLED_PLUGINS === 'true'
  };
}

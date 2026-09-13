export interface Config {
  port: number;
  /** undefined = all builtin plugins enabled */
  enabledBuiltins?: string[];
  externalModules: string[];
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
    enabledBuiltins: splitList(env.ENABLED_PLUGINS),
    externalModules: splitList(env.EXTERNAL_PLUGINS) ?? []
  };
}

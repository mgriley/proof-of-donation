export interface Config {
  port: number;
  dbPath: string;
  /** undefined = all builtin plugins enabled */
  enabledBuiltins?: string[];
  externalModules: string[];
  /** Hard server-side ceiling on how large a caller-supplied maxAgeHours may be. */
  maxAgeHoursCeiling: number;
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
    dbPath: env.DB_PATH ?? './data/proof-of-donation.sqlite',
    enabledBuiltins: splitList(env.ENABLED_PLUGINS),
    externalModules: splitList(env.EXTERNAL_PLUGINS) ?? [],
    maxAgeHoursCeiling: Number.parseInt(env.MAX_AGE_HOURS_CEILING ?? '720', 10)
  };
}

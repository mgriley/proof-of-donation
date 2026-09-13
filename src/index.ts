import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { loadPlugins } from './plugins/loader.js';
import { ReceiptStore } from './db.js';
import { createServer } from './server.js';

async function main() {
  const config = loadConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const plugins = await loadPlugins({
    enabledBuiltins: config.enabledBuiltins,
    externalModules: config.externalModules
  });

  if (plugins.length === 0) {
    console.warn('Warning: no receipt plugins are enabled -- every /verify request will fail.');
  } else {
    console.log(`Loaded plugins: ${plugins.map((p) => p.id).join(', ')}`);
  }

  const store = new ReceiptStore(config.dbPath);
  const app = createServer(plugins, store, config.maxAgeHoursCeiling);

  const server = app.listen(config.port, () => {
    console.log(`proof-of-donation listening on http://localhost:${config.port}`);
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting proof-of-donation:', err);
  process.exit(1);
});
